import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const WEEK_SECONDS = 7 * 24 * 60 * 60;

// Cheap pre-filter before JSON.parse; JSON allows whitespace around the
// colon, so a bare '"type":"token_count"' substring match misses pretty
// printed variants such as '"type": "token_count"'.
const TOKEN_EVENT_PATTERN = /"type"\s*:\s*"(?:token_count|turn_context)"/;

// A fresh rollout file starts its cumulative counter near zero, so the
// first event's total roughly equals its per-turn last. A resume/fork
// rollout inherits the parent session's counter, making total dwarf last
// (observed: total 195,573,881 vs last 128,017). 3x separates the two
// cases with wide margin while keeping single lost events (total <= 3x
// last) counted in full.
const INHERITED_COUNTER_RATIO = 3;

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

function epochToMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  // Codex writes resets_at in seconds; tolerate millisecond input too.
  return Math.round(number < 10_000_000_000 ? number * 1000 : number);
}

function rateLimitWindow(payload) {
  const secondary = payload?.rate_limits?.secondary;
  const windowMinutes = Number(secondary?.window_minutes);
  const resetsAtMs = epochToMs(secondary?.resets_at);
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0 || !resetsAtMs) {
    return null;
  }
  return { windowSeconds: Math.round(windowMinutes * 60), resetsAtMs };
}

async function readTokenCountRecords(path) {
  const records = [];
  let model = "Codex";
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!TOKEN_EVENT_PATTERN.test(line)) continue;
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
      cachedTokens: finiteTokenCount(
        event.payload?.info?.total_token_usage?.cached_input_tokens,
      ),
      cachedLastTokens: finiteTokenCount(
        event.payload?.info?.last_token_usage?.cached_input_tokens,
      ),
      rateLimitWindow: rateLimitWindow(event.payload),
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
  let cachedInputTokens = 0;

  for (const [sessionId, sessionRecords] of sessions) {
    sessionRecords.sort((left, right) => left.timestamp - right.timestamp);
    let previousTotal = null;
    let previousCached = null;
    for (const record of sessionRecords) {
      const currentTotal = finiteTokenCount(record.totalTokens);
      if (currentTotal === null) continue;
      const lastTokens = finiteTokenCount(record.lastTokens);

      let increment;
      let inheritedCounter = false;
      if (previousTotal === null) {
        // First event of a file: a resume/fork rollout inherits the parent
        // session's cumulative counter, so counting the full total would
        // double-count usage already attributed to the parent file. Only
        // the last turn is new in that case; a fresh file (total within
        // 3x of last, or no last to compare against) is counted in full.
        inheritedCounter =
          lastTokens !== null && currentTotal > lastTokens * INHERITED_COUNTER_RATIO;
        increment = inheritedCounter ? lastTokens : currentTotal;
      } else {
        // Counter deltas are the source of truth: last_token_usage only
        // covers a single turn, so preferring it undercounts whenever an
        // event is lost between two observed ones. Fall back to the last
        // turn only when the counter regressed or reset.
        const delta = currentTotal - previousTotal;
        increment = delta > 0 ? delta : (lastTokens ?? currentTotal);
      }
      previousTotal = currentTotal;

      // Cached-input counter, same counter-delta method as the total.
      const currentCached = finiteTokenCount(record.cachedTokens);
      const lastCached = finiteTokenCount(record.cachedLastTokens);
      let cachedIncrement = 0;
      if (currentCached !== null) {
        if (previousCached === null) {
          cachedIncrement = inheritedCounter ? (lastCached ?? 0) : currentCached;
        } else {
          const delta = currentCached - previousCached;
          cachedIncrement = delta > 0 ? delta : (lastCached ?? currentCached);
        }
        previousCached = currentCached;
      }

      if (record.timestamp < sinceMs) continue;
      if (increment <= 0 && cachedIncrement <= 0) continue;

      totalTokens += increment;
      cachedInputTokens += cachedIncrement;
      countedSessions.add(sessionId);
      const model = record.model || "Codex";
      const entry = modelTotals.get(model) || { totalTokens: 0, cachedInputTokens: 0 };
      entry.totalTokens += increment;
      entry.cachedInputTokens += cachedIncrement;
      modelTotals.set(model, entry);
    }
  }

  return {
    totalTokens,
    cachedInputTokens,
    sessionCount: countedSessions.size,
    models: Array.from(modelTotals, ([label, entry]) => ({
      id: `codex-log-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      label,
      estimatedTokens: entry.totalTokens,
      cachedInputTokens: entry.cachedInputTokens,
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

  const fallbackSinceMs = now - WEEK_SECONDS * 1000;
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  const records = [];

  for await (const path of jsonlFiles(join(codexHome, "sessions"))) {
    try {
      const metadata = await stat(path);
      // The fallback week is a superset of the quota-aligned window, so it
      // is safe to skip files untouched since then.
      if (metadata.mtimeMs < fallbackSinceMs) continue;
      records.push(...(await readTokenCountRecords(path)));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`跳过无法读取的 Codex 会话日志：${basename(path)}`);
      }
    }
  }

  // Align the window with the subscription quota cycle: token_count events
  // embed rate_limits.secondary from the same source as the quota API, so
  // the latest one pins the current weekly window. Reject stale windows
  // that ended before the fallback week, then fall back to now-7d.
  let alignedWindow = null;
  for (const record of records) {
    if (
      record.rateLimitWindow &&
      (!alignedWindow || record.timestamp > alignedWindow.timestamp)
    ) {
      alignedWindow = { timestamp: record.timestamp, ...record.rateLimitWindow };
    }
  }
  let sinceMs = fallbackSinceMs;
  let periodSeconds = WEEK_SECONDS;
  if (alignedWindow) {
    const startMs = alignedWindow.resetsAtMs - alignedWindow.windowSeconds * 1000;
    if (startMs <= now && alignedWindow.resetsAtMs >= fallbackSinceMs) {
      sinceMs = startMs;
      periodSeconds = alignedWindow.windowSeconds;
    }
  }

  const summary = summarizeTokenCountRecords(records, sinceMs);
  if (summary.totalTokens === 0) return null;
  return {
    basis: "session_logs",
    estimated: true,
    totalTokens: summary.totalTokens,
    cachedInputTokens: summary.cachedInputTokens,
    periodSeconds,
    periodStartAt: new Date(sinceMs).toISOString(),
    sessionCount: summary.sessionCount,
    models: summary.models,
    assumption:
      "仅统计这台 Mac 的 Codex 会话日志，按订阅周期窗口（与配额 API 的周窗口对齐，取不到时回退为最近 7 天）累计 token_count 增量；totalTokens 是含缓存读取的原始 token 量，cachedInputTokens 是其中的缓存读部分；不读取或上传提示词与回复正文，跨设备用量不会包含在内。",
  };
}
