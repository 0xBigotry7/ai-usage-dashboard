import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const DAY_MS = 86_400_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

// The reporting window is 7 days. Real installs can hold thousands of session
// files, so files are pre-filtered by mtime before any line is read; the one
// extra day of margin covers records written just before a day boundary.
const FILE_MTIME_WINDOW_MS = 8 * DAY_MS;

export function claudeProjectsDir(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(configDir, "projects");
}

async function* jsonlFiles(directory, onError) {
  let entries;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") onError(error);
    return;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* jsonlFiles(path, onError);
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name.endsWith(".jsonl")
    ) {
      yield path;
    }
  }
}

function finiteTokenCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return null;
  return Math.floor(count);
}

async function readAssistantUsageRecords(path, dedupedRecords) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let unkeyedLine = 0;

  try {
    for await (const line of lines) {
      // Cheap pre-filter before JSON.parse: only records that carry a
      // message.usage block are interesting, and all of them contain the
      // literal key "usage" somewhere in the line.
      if (!line.includes('"usage"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== "assistant") continue;
      const message = record.message;
      const usage = message?.usage;
      if (!usage || typeof usage !== "object") continue;
      const model = typeof message.model === "string" ? message.model : null;
      // "<synthetic>" marks locally generated error/placeholder turns that
      // never reached the API.
      if (!model || model === "<synthetic>") continue;
      const timestamp = new Date(record.timestamp).getTime();
      if (!Number.isFinite(timestamp)) continue;

      const inputTokens = finiteTokenCount(usage.input_tokens);
      const cacheCreationTokens = finiteTokenCount(
        usage.cache_creation_input_tokens,
      );
      const cacheReadTokens = finiteTokenCount(usage.cache_read_input_tokens);
      const outputTokens = finiteTokenCount(usage.output_tokens);
      if (
        inputTokens === null &&
        cacheCreationTokens === null &&
        cacheReadTokens === null &&
        outputTokens === null
      ) {
        continue;
      }

      // The same logical API call can be logged more than once (streaming
      // rewrites, retries, and resumed sessions that replay the transcript
      // into a new file). Dedupe on requestId plus the message/record id and
      // keep the last occurrence, which carries the final usage numbers.
      const messageKey =
        (typeof message.id === "string" && message.id) ||
        (typeof record.uuid === "string" && record.uuid) ||
        null;
      const requestKey =
        typeof record.requestId === "string" ? record.requestId : "";
      const key = messageKey
        ? `${requestKey}:${messageKey}`
        : `${path}:${(unkeyedLine += 1)}`;
      // Subagent (isSidechain) turns consume real tokens and are included.
      dedupedRecords.set(key, {
        timestamp,
        model,
        sessionId:
          typeof record.sessionId === "string" && record.sessionId
            ? record.sessionId
            : basename(path, ".jsonl"),
        inputTokens: inputTokens ?? 0,
        cacheCreationTokens: cacheCreationTokens ?? 0,
        cacheReadTokens: cacheReadTokens ?? 0,
        outputTokens: outputTokens ?? 0,
      });
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export function summarizeClaudeUsageRecords(records, sinceMs, untilMs) {
  const modelTotals = new Map();
  const countedSessions = new Set();
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  for (const record of records) {
    if (record.timestamp < sinceMs || record.timestamp > untilMs) continue;
    // Claude Code logs uncached input, cache creation, and cache reads as
    // separate counters. All three are billed input, so the reported input
    // total is their sum; cache reads are additionally kept as the
    // non-additive cached-input subset.
    const recordInput =
      record.inputTokens + record.cacheCreationTokens + record.cacheReadTokens;
    inputTokens += recordInput;
    cachedInputTokens += record.cacheReadTokens;
    outputTokens += record.outputTokens;
    countedSessions.add(record.sessionId);

    const entry = modelTotals.get(record.model) || {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    entry.inputTokens += recordInput;
    entry.cachedInputTokens += record.cacheReadTokens;
    entry.outputTokens += record.outputTokens;
    modelTotals.set(record.model, entry);
  }

  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    sessionCount: countedSessions.size,
    models: Array.from(modelTotals, ([label, entry]) => ({
      id: `claude-log-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      label,
      estimatedTokens: entry.inputTokens + entry.outputTokens,
      inputTokens: entry.inputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
      countedInTotal: true,
    })).sort((left, right) => right.estimatedTokens - left.estimatedTokens),
  };
}

function localDayStartMs(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function sessionLogEstimate(
  summary,
  sinceMs,
  periodSeconds,
  periodId,
  assumption,
  coverageIncomplete,
) {
  if (summary.totalTokens === 0) return null;
  return {
    basis: "session_logs",
    periodId,
    scope: "local_device",
    estimated: coverageIncomplete,
    totalTokens: summary.totalTokens,
    inputTokens: summary.inputTokens,
    cachedInputTokens: summary.cachedInputTokens,
    outputTokens: summary.outputTokens,
    periodSeconds,
    periodStartAt: new Date(sinceMs).toISOString(),
    sessionCount: summary.sessionCount,
    models: summary.models,
    assumption: coverageIncomplete
      ? `${assumption} Some session log files could not be read, so this total is approximate.`
      : assumption,
  };
}

export async function estimateClaudeSessionLogTokenEstimates(
  env = process.env,
  now = Date.now(),
) {
  if (/^(?:0|false|off|no)$/i.test(env.USAGE_HUB_CLAUDE_LOG_ESTIMATE || "")) {
    return [];
  }

  const dedupedRecords = new Map();
  const recentPaths = [];
  let unreadableEntries = 0;
  const countUnreadable = () => {
    unreadableEntries += 1;
  };
  const mtimeCutoffMs = now - FILE_MTIME_WINDOW_MS;

  for await (const path of jsonlFiles(claudeProjectsDir(env), countUnreadable)) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs >= mtimeCutoffMs) recentPaths.push(path);
    } catch {
      unreadableEntries += 1;
    }
  }

  for (const path of recentPaths) {
    try {
      await readAssistantUsageRecords(path, dedupedRecords);
    } catch (error) {
      // A single unreadable file must not abort the walk; count it and mark
      // the resulting estimates as approximate.
      unreadableEntries += 1;
      if (error?.code !== "ENOENT") {
        console.warn(
          `Skipping unreadable Claude Code session log: ${basename(path)}`,
        );
      }
    }
  }

  const coverageIncomplete = unreadableEntries > 0;
  const records = Array.from(dedupedRecords.values());

  const todaySinceMs = localDayStartMs(now);
  const todaySeconds = Math.max(60, Math.round((now - todaySinceMs) / 1000));
  const today = sessionLogEstimate(
    summarizeClaudeUsageRecords(records, todaySinceMs, now),
    todaySinceMs,
    todaySeconds,
    "today",
    "Counts deduplicated per-message usage from this machine's Claude Code session logs since local midnight; total = input (including cache creation and cache reads) + output. Message content is never read.",
    coverageIncomplete,
  );
  const rollingSinceMs = now - WEEK_SECONDS * 1000;
  const rolling7d = sessionLogEstimate(
    summarizeClaudeUsageRecords(records, rollingSinceMs, now),
    rollingSinceMs,
    WEEK_SECONDS,
    "rolling_7d",
    "Counts deduplicated per-message usage from this machine's Claude Code session logs over the trailing 7 days; usage on other devices is not included.",
    coverageIncomplete,
  );
  return [today, rolling7d].filter(Boolean);
}
