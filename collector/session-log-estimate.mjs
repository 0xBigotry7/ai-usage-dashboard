import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const WEEK_SECONDS = 7 * 24 * 60 * 60;

async function* jsonlFiles(directory) {
  let entries;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* jsonlFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield path;
    }
  }
}

function finiteTokenCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return null;
  return Math.floor(count);
}

async function readTokenCountRecords(path) {
  const records = [];
  let model = "Codex";
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (
      !line.includes('"type":"token_count"') &&
      !line.includes('"type":"turn_context"')
    ) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (
      event.type === "turn_context" &&
      typeof event.payload?.model === "string" &&
      event.payload.model.length <= 80
    ) {
      model = event.payload.model;
      continue;
    }
    if (event.payload?.type !== "token_count") continue;

    const timestamp = new Date(event.timestamp).getTime();
    const totalTokens = finiteTokenCount(
      event.payload?.info?.total_token_usage?.total_tokens,
    );
    const lastTokens = finiteTokenCount(
      event.payload?.info?.last_token_usage?.total_tokens,
    );
    if (!Number.isFinite(timestamp) || totalTokens === null) continue;
    records.push({
      sessionId: basename(path, ".jsonl"),
      timestamp,
      totalTokens,
      lastTokens,
      model,
    });
  }
  return records;
}

export function summarizeTokenCountRecords(records, sinceMs) {
  const sessions = new Map();
  for (const record of records) {
    if (!record || !Number.isFinite(record.timestamp)) continue;
    const session = sessions.get(record.sessionId) || [];
    session.push(record);
    sessions.set(record.sessionId, session);
  }

  const modelTotals = new Map();
  const countedSessions = new Set();
  let totalTokens = 0;

  for (const [sessionId, sessionRecords] of sessions) {
    sessionRecords.sort((left, right) => left.timestamp - right.timestamp);
    let previousTotal = 0;
    for (const record of sessionRecords) {
      const currentTotal = finiteTokenCount(record.totalTokens);
      if (currentTotal === null) continue;
      const totalIncrement =
        currentTotal >= previousTotal ? currentTotal - previousTotal : currentTotal;
      previousTotal = currentTotal;
      const lastTokens = finiteTokenCount(record.lastTokens);
      const increment =
        lastTokens !== null && totalIncrement > 0 ? lastTokens : totalIncrement;
      if (record.timestamp < sinceMs || increment <= 0) continue;

      totalTokens += increment;
      countedSessions.add(sessionId);
      const model = record.model || "Codex";
      modelTotals.set(model, (modelTotals.get(model) || 0) + increment);
    }
  }

  return {
    totalTokens,
    sessionCount: countedSessions.size,
    models: Array.from(modelTotals, ([label, estimatedTokens]) => ({
      id: `codex-log-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      label,
      estimatedTokens,
      countedInTotal: true,
    })).sort((left, right) => right.estimatedTokens - left.estimatedTokens),
  };
}

export async function estimateCodexSessionLogTokens(
  env = process.env,
  now = Date.now(),
) {
  if (/^(?:0|false|off|no)$/i.test(env.USAGE_HUB_CODEX_LOG_ESTIMATE || "")) {
    return null;
  }

  const sinceMs = now - WEEK_SECONDS * 1000;
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  const records = [];

  for await (const path of jsonlFiles(join(codexHome, "sessions"))) {
    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs < sinceMs) continue;
      records.push(...(await readTokenCountRecords(path)));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`跳过无法读取的 Codex 会话日志：${basename(path)}`);
      }
    }
  }

  const summary = summarizeTokenCountRecords(records, sinceMs);
  if (summary.totalTokens === 0) return null;
  return {
    basis: "session_logs",
    estimated: true,
    totalTokens: summary.totalTokens,
    periodSeconds: WEEK_SECONDS,
    sessionCount: summary.sessionCount,
    models: summary.models,
    assumption:
      "汇总本机 Codex 会话日志中过去 7 天的累计 token_count 增量；不读取或上传提示词与回复正文，跨设备用量不会包含在内。",
  };
}
