import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const DAY_MS = 86_400_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

// The reporting window is 7 days. Real installs can hold thousands of session
// files, so files are pre-filtered by mtime before any line is read; the one
// extra day of margin covers records written just before a day boundary.
const FILE_MTIME_WINDOW_MS = 8 * DAY_MS;

// A corrupted file without a newline would otherwise be buffered into memory
// as one enormous "line" before it could be rejected. Longer lines are
// discarded while streaming and reported so the estimate is marked
// approximate.
const MAX_LINE_LENGTH = 4 * 1024 * 1024;

// Per-file parse cache. Session logs are append-only, so a file whose size
// and mtime both match the previous scan yields exactly the entries it
// yielded last time; re-reading it is pure waste. Entries for files the
// latest scan did not visit (outside the mtime window, or deleted) are
// evicted so the cache tracks the reporting window instead of growing
// forever.
const fileCache = new Map();
let lastScanHits = 0;
let lastScanMisses = 0;

// Test hook: cache occupancy plus hit/miss counters for the most recent scan.
export function _cacheStats() {
  return { files: fileCache.size, hits: lastScanHits, misses: lastScanMisses };
}

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

// Streams a JSONL file line by line while never holding more than one
// bounded line in memory. Lines longer than MAX_LINE_LENGTH are dropped as
// they stream past and reported once each through onOversizedLine.
async function* boundedJsonlLines(path, onOversizedLine) {
  const input = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: 256 * 1024,
  });
  let tail = "";
  let skippingOversized = false;
  try {
    for await (const chunk of input) {
      const pieces = (tail + chunk).split("\n");
      tail = pieces.pop();
      for (const piece of pieces) {
        if (skippingOversized) {
          // This newline terminates the line that already blew the limit.
          skippingOversized = false;
          onOversizedLine();
        } else if (piece.length > MAX_LINE_LENGTH) {
          onOversizedLine();
        } else {
          yield piece.endsWith("\r") ? piece.slice(0, -1) : piece;
        }
      }
      if (skippingOversized) {
        tail = "";
      } else if (tail.length > MAX_LINE_LENGTH) {
        tail = "";
        skippingOversized = true;
      }
    }
  } finally {
    input.destroy();
  }
  if (skippingOversized || tail.length > MAX_LINE_LENGTH) {
    onOversizedLine();
  } else if (tail) {
    yield tail;
  }
}

async function readAssistantUsageRecords(path) {
  const entries = [];
  let oversizedLines = 0;
  let unkeyedLine = 0;

  for await (const line of boundedJsonlLines(path, () => {
    oversizedLines += 1;
  })) {
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
    // Entries stay in file order so replaying them into the shared dedupe
    // map reproduces exactly what a direct scan produced.
    entries.push([
      key,
      {
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
      },
    ]);
  }
  return { entries, oversizedLines };
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
  coverageNote,
) {
  if (summary.totalTokens === 0) return null;
  return {
    basis: "session_logs",
    periodId,
    scope: "local_device",
    estimated: Boolean(coverageNote),
    totalTokens: summary.totalTokens,
    inputTokens: summary.inputTokens,
    cachedInputTokens: summary.cachedInputTokens,
    outputTokens: summary.outputTokens,
    periodSeconds,
    periodStartAt: new Date(sinceMs).toISOString(),
    sessionCount: summary.sessionCount,
    models: summary.models,
    assumption: coverageNote ? `${assumption} ${coverageNote}` : assumption,
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
  const recentFiles = [];
  let unreadableEntries = 0;
  let oversizedLineCount = 0;
  const countUnreadable = () => {
    unreadableEntries += 1;
  };
  const mtimeCutoffMs = now - FILE_MTIME_WINDOW_MS;

  for await (const path of jsonlFiles(claudeProjectsDir(env), countUnreadable)) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs >= mtimeCutoffMs) {
        recentFiles.push({
          path,
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        });
      }
    } catch {
      unreadableEntries += 1;
    }
  }

  lastScanHits = 0;
  lastScanMisses = 0;
  for (const { path, size, mtimeMs } of recentFiles) {
    let cached = fileCache.get(path);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      lastScanHits += 1;
    } else {
      lastScanMisses += 1;
      try {
        const parsed = await readAssistantUsageRecords(path);
        // The size/mtime pair predates the read; if the file grew in
        // between, the next scan's stat differs from it and re-parses. The
        // stale direction (cache hit on changed content) cannot happen.
        cached = { size, mtimeMs, ...parsed };
        fileCache.set(path, cached);
      } catch (error) {
        // A single unreadable file must not abort the walk; count it and
        // mark the resulting estimates as approximate.
        fileCache.delete(path);
        unreadableEntries += 1;
        if (error?.code !== "ENOENT") {
          console.warn(
            `Skipping unreadable Claude Code session log: ${basename(path)}`,
          );
        }
        continue;
      }
    }
    // Replay in walk order so cross-file "last occurrence wins" dedupe
    // behaves identically whether entries came from disk or from cache.
    for (const [key, record] of cached.entries) {
      dedupedRecords.set(key, record);
    }
    oversizedLineCount += cached.oversizedLines;
  }

  // Drop cache entries for files this scan did not visit (aged out of the
  // mtime window or deleted) so cache memory stays bounded by the window.
  const visitedPaths = new Set(recentFiles.map((file) => file.path));
  for (const path of fileCache.keys()) {
    if (!visitedPaths.has(path)) fileCache.delete(path);
  }

  const coverageNote =
    [
      unreadableEntries > 0
        ? "Some session log files could not be read, so this total is approximate."
        : "",
      oversizedLineCount > 0
        ? "Log lines longer than 4MB were skipped as corrupted, so this total is approximate."
        : "",
    ]
      .filter(Boolean)
      .join(" ") || null;
  const records = Array.from(dedupedRecords.values());

  const todaySinceMs = localDayStartMs(now);
  const todaySeconds = Math.max(60, Math.round((now - todaySinceMs) / 1000));
  const today = sessionLogEstimate(
    summarizeClaudeUsageRecords(records, todaySinceMs, now),
    todaySinceMs,
    todaySeconds,
    "today",
    "Counts deduplicated per-message usage from this machine's Claude Code session logs since local midnight; total = input (including cache creation and cache reads) + output. Message content is never read.",
    coverageNote,
  );
  const rollingSinceMs = now - WEEK_SECONDS * 1000;
  const rolling7d = sessionLogEstimate(
    summarizeClaudeUsageRecords(records, rollingSinceMs, now),
    rollingSinceMs,
    WEEK_SECONDS,
    "rolling_7d",
    "Counts deduplicated per-message usage from this machine's Claude Code session logs over the trailing 7 days; usage on other devices is not included.",
    coverageNote,
  );
  return [today, rolling7d].filter(Boolean);
}
