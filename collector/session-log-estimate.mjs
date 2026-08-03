import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const WEEK_SECONDS = 7 * 24 * 60 * 60;

// A corrupted file without a newline would otherwise be buffered into memory
// as one enormous "line" before it could be rejected. Longer lines are
// discarded while streaming and reported so the estimate is marked
// approximate.
const MAX_LINE_LENGTH = 4 * 1024 * 1024;

// Per-file parse cache. Rollout files are append-only, so a file whose size
// and mtime both match the previous scan yields exactly the records it
// yielded last time; re-reading it is pure waste. Entries for files the
// latest scan did not visit (outside the mtime window and not referenced as
// an ancestor, or deleted) are evicted so the cache stays bounded.
const fileCache = new Map();
let lastScanHits = 0;
let lastScanMisses = 0;

// Test hook: cache occupancy plus hit/miss counters for the most recent scan.
export function _cacheStats() {
  return { files: fileCache.size, hits: lastScanHits, misses: lastScanMisses };
}

// Cheap pre-filter before JSON.parse; JSON allows whitespace around the
// colon, so a bare '"type":"token_count"' substring match misses pretty
// printed variants such as '"type": "token_count"'.
const TOKEN_EVENT_PATTERN =
  /"type"\s*:\s*"(?:session_meta|token_count|turn_context)"/;

// Older rollout files may not expose relationship metadata. Keep a
// conservative fallback for those files, but prefer session_meta's explicit
// fork/resume fields whenever they are available.
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

function normalizedRateLimitWindow(value) {
  const windowMinutes = Number(value?.window_minutes);
  const resetsAtMs = epochToMs(value?.resets_at);
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0 || !resetsAtMs) {
    return null;
  }
  return { windowSeconds: Math.round(windowMinutes * 60), resetsAtMs };
}

function rateLimitWindow(payload) {
  // Codex has emitted the weekly quota as either primary or secondary across
  // versions. This estimator is explicitly weekly, so choose the 10,080-minute
  // candidate instead of assuming a fixed slot or accidentally aligning to a
  // shorter session window.
  return [
    payload?.rate_limits?.primary,
    payload?.rate_limits?.secondary,
  ]
    .map(normalizedRateLimitWindow)
    .find((window) => window?.windowSeconds === WEEK_SECONDS) || null;
}

function rolloutIdForPath(path) {
  const fileId = basename(path, ".jsonl");
  return (
    fileId.match(
      /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i,
    )?.[1] || fileId
  );
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

async function readTokenCountRecords(path) {
  const records = [];
  const rolloutId = rolloutIdForPath(path);
  let model = "Codex";
  let inheritedCounter = null;
  let parentRolloutId = null;
  let oversizedLines = 0;

  for await (const line of boundedJsonlLines(path, () => {
    oversizedLines += 1;
  })) {
    if (!TOKEN_EVENT_PATTERN.test(line)) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "session_meta") {
      const metadata = event.payload;
      // A forked rollout can embed the parent's session_meta after its own.
      // Only the metadata whose id belongs to this file describes whether
      // this file inherited a counter.
      if (
        inheritedCounter !== null ||
        typeof metadata?.id !== "string" ||
        metadata.id !== rolloutId
      ) {
        continue;
      }
      const sessionId =
        typeof metadata?.session_id === "string"
          ? metadata.session_id
          : null;
      parentRolloutId =
        (typeof metadata?.forked_from_id === "string" &&
          metadata.forked_from_id) ||
        (typeof metadata?.parent_thread_id === "string" &&
          metadata.parent_thread_id) ||
        (sessionId && rolloutId !== sessionId ? sessionId : null);
      inheritedCounter = Boolean(parentRolloutId);
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
      rolloutId,
      parentRolloutId,
      timestamp,
      totalTokens,
      lastTokens,
      inputTokens: finiteTokenCount(
        event.payload?.info?.total_token_usage?.input_tokens,
      ),
      inputLastTokens: finiteTokenCount(
        event.payload?.info?.last_token_usage?.input_tokens,
      ),
      cachedTokens: finiteTokenCount(
        event.payload?.info?.total_token_usage?.cached_input_tokens,
      ),
      cachedLastTokens: finiteTokenCount(
        event.payload?.info?.last_token_usage?.cached_input_tokens,
      ),
      cacheWriteTokens: finiteTokenCount(
        event.payload?.info?.total_token_usage?.cache_write_input_tokens,
      ),
      outputTokens: finiteTokenCount(
        event.payload?.info?.total_token_usage?.output_tokens,
      ),
      outputLastTokens: finiteTokenCount(
        event.payload?.info?.last_token_usage?.output_tokens,
      ),
      reasoningOutputTokens: finiteTokenCount(
        event.payload?.info?.total_token_usage?.reasoning_output_tokens,
      ),
      reasoningOutputLastTokens: finiteTokenCount(
        event.payload?.info?.last_token_usage?.reasoning_output_tokens,
      ),
      inheritedCounter,
      rateLimitWindow: rateLimitWindow(event.payload),
      model,
    });
  }
  return { rolloutId, parentRolloutId, records, oversizedLines };
}

function cumulativeStateKey(record) {
  const total = finiteTokenCount(record?.totalTokens);
  if (total === null) return null;
  return JSON.stringify([
    total,
    finiteTokenCount(record.inputTokens),
    finiteTokenCount(record.cachedTokens),
    finiteTokenCount(record.cacheWriteTokens),
    finiteTokenCount(record.outputTokens),
    finiteTokenCount(record.reasoningOutputTokens),
  ]);
}

function removeAncestorReplayRecords(records) {
  const recordsByRollout = new Map();
  const parentByRollout = new Map();

  for (const record of records) {
    const rolloutId = record?.rolloutId || record?.sessionId;
    if (!rolloutId) continue;
    if (record.parentRolloutId) {
      parentByRollout.set(rolloutId, record.parentRolloutId);
    }
    const rolloutRecords = recordsByRollout.get(rolloutId) || [];
    rolloutRecords.push(record);
    recordsByRollout.set(rolloutId, rolloutRecords);
  }

  const longestAncestorPrefix = (childRecords, ancestorRecords) => {
    if (!childRecords.length || !ancestorRecords.length) return 0;
    const childKeys = childRecords.map(cumulativeStateKey);
    const ancestorKeys = ancestorRecords.map(cumulativeStateKey);
    const positions = new Map();
    for (let index = 0; index < ancestorKeys.length; index += 1) {
      const key = ancestorKeys[index];
      if (!key) continue;
      const matches = positions.get(key) || [];
      matches.push(index);
      positions.set(key, matches);
    }
    let longest = 0;
    for (const start of positions.get(childKeys[0]) || []) {
      let length = 0;
      while (
        length < childKeys.length &&
        start + length < ancestorKeys.length &&
        childKeys[length] === ancestorKeys[start + length]
      ) {
        length += 1;
      }
      longest = Math.max(longest, length);
    }
    return longest;
  };

  const replayedRecords = new Set();
  const recordOverrides = new Map();
  const markReplayPrefix = (rolloutRecords, replayLength) => {
    if (replayLength <= 0) return;
    for (const record of rolloutRecords.slice(0, replayLength - 1)) {
      replayedRecords.add(record);
    }
    const baseline = rolloutRecords[replayLength - 1];
    recordOverrides.set(baseline, {
      ...baseline,
      replayedAncestorBaseline: true,
    });
  };

  for (const [rolloutId, childRecords] of recordsByRollout) {
    const visited = new Set([rolloutId]);
    let ancestorId = parentByRollout.get(rolloutId);
    while (ancestorId && !visited.has(ancestorId)) {
      const ancestorRecords = recordsByRollout.get(ancestorId);
      if (ancestorRecords?.length) {
        const replayLength = longestAncestorPrefix(
          childRecords,
          ancestorRecords,
        );
        if (replayLength > 0) {
          markReplayPrefix(childRecords, replayLength);
          break;
        }
      }
      visited.add(ancestorId);
      ancestorId = parentByRollout.get(ancestorId);
    }
  }

  // An ancestor file may have been deleted while two or more children still
  // contain the same inherited prefix. Keep one copy of that shared history,
  // and turn the other copies' final matching state into delta baselines.
  const missingParentGroups = new Map();
  for (const [rolloutId, parentRolloutId] of parentByRollout) {
    if (recordsByRollout.has(parentRolloutId)) continue;
    const siblings = missingParentGroups.get(parentRolloutId) || [];
    siblings.push(recordsByRollout.get(rolloutId) || []);
    missingParentGroups.set(parentRolloutId, siblings);
  }
  for (const siblings of missingParentGroups.values()) {
    if (siblings.length < 2 || siblings.some((records) => !records.length)) {
      continue;
    }
    const siblingKeys = siblings.map((rolloutRecords) =>
      rolloutRecords.map(cumulativeStateKey),
    );
    const maxPrefix = Math.min(...siblingKeys.map((keys) => keys.length));
    let sharedLength = 0;
    while (
      sharedLength < maxPrefix &&
      siblingKeys[0][sharedLength] &&
      siblingKeys.every(
        (keys) => keys[sharedLength] === siblingKeys[0][sharedLength],
      )
    ) {
      sharedLength += 1;
    }
    if (sharedLength === 0) continue;

    const ownerFirstRecord = siblings[0][0];
    recordOverrides.set(ownerFirstRecord, {
      ...ownerFirstRecord,
      countSharedReplayBaseline: true,
    });
    for (const siblingRecords of siblings.slice(1)) {
      markReplayPrefix(siblingRecords, sharedLength);
    }
  }

  return records
    .filter((record) => !replayedRecords.has(record))
    .map((record) => recordOverrides.get(record) || record);
}

export function summarizeTokenCountRecords(
  records,
  sinceMs,
  untilMs = Number.POSITIVE_INFINITY,
) {
  const sessions = new Map();
  for (const record of removeAncestorReplayRecords(records)) {
    if (!record || !Number.isFinite(record.timestamp)) continue;
    const session = sessions.get(record.sessionId) || [];
    session.push(record);
    sessions.set(record.sessionId, session);
  }

  const modelTotals = new Map();
  const countedSessions = new Set();
  let totalTokens = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let inputOutputComplete = true;
  let cachedInputComplete = true;
  let reasoningOutputComplete = true;

  for (const [sessionId, sessionRecords] of sessions) {
    sessionRecords.sort((left, right) => left.timestamp - right.timestamp);
    let previousTotal = null;
    let previousInput = null;
    let previousCached = null;
    let previousOutput = null;
    let previousReasoningOutput = null;
    for (const record of sessionRecords) {
      if (record.timestamp > untilMs) break;
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
          record.countSharedReplayBaseline !== true &&
          (record.inheritedCounter === true ||
            (record.inheritedCounter !== false &&
              lastTokens !== null &&
              currentTotal > lastTokens * INHERITED_COUNTER_RATIO));
        increment =
          inheritedCounter ? (lastTokens ?? currentTotal) : currentTotal;
      } else {
        // Counter deltas are the source of truth: last_token_usage only
        // covers a single turn, so preferring it undercounts whenever an
        // event is lost between two observed ones. When the counter regresses,
        // the new cumulative epoch is the only complete baseline available.
        const delta = currentTotal - previousTotal;
        increment =
          delta > 0
            ? delta
            : delta < 0
              ? currentTotal
              : 0;
      }
      previousTotal = currentTotal;

      const componentIncrement = (currentValue, previousValue, lastValue) => {
        const current = finiteTokenCount(currentValue);
        if (current === null) {
          return { increment: 0, previous: previousValue };
        }
        const last = finiteTokenCount(lastValue);
        if (previousValue === null) {
          return {
            increment: inheritedCounter ? (last ?? 0) : current,
            previous: current,
          };
        }
        const delta = current - previousValue;
        return {
          increment: delta > 0 ? delta : delta < 0 ? current : 0,
          previous: current,
        };
      };

      const inputCounter = componentIncrement(
        record.inputTokens,
        previousInput,
        record.inputLastTokens,
      );
      previousInput = inputCounter.previous;
      const cachedCounter = componentIncrement(
        record.cachedTokens,
        previousCached,
        record.cachedLastTokens,
      );
      previousCached = cachedCounter.previous;
      const outputCounter = componentIncrement(
        record.outputTokens,
        previousOutput,
        record.outputLastTokens,
      );
      previousOutput = outputCounter.previous;
      const reasoningCounter = componentIncrement(
        record.reasoningOutputTokens,
        previousReasoningOutput,
        record.reasoningOutputLastTokens,
      );
      previousReasoningOutput = reasoningCounter.previous;

      if (record.replayedAncestorBaseline === true) continue;
      if (record.timestamp < sinceMs) continue;
      if (
        increment <= 0 &&
        inputCounter.increment <= 0 &&
        cachedCounter.increment <= 0 &&
        outputCounter.increment <= 0 &&
        reasoningCounter.increment <= 0
      ) {
        continue;
      }

      const hasInput = finiteTokenCount(record.inputTokens) !== null;
      const hasOutput = finiteTokenCount(record.outputTokens) !== null;
      const hasCachedInput = finiteTokenCount(record.cachedTokens) !== null;
      const hasReasoningOutput =
        finiteTokenCount(record.reasoningOutputTokens) !== null;
      inputOutputComplete = inputOutputComplete && hasInput && hasOutput;
      cachedInputComplete = cachedInputComplete && hasCachedInput;
      reasoningOutputComplete =
        reasoningOutputComplete && hasReasoningOutput;

      totalTokens += increment;
      inputTokens += inputCounter.increment;
      cachedInputTokens += cachedCounter.increment;
      outputTokens += outputCounter.increment;
      reasoningOutputTokens += reasoningCounter.increment;
      countedSessions.add(sessionId);
      const model = record.model || "Codex";
      const entry = modelTotals.get(model) || {
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        inputOutputComplete: true,
        cachedInputComplete: true,
        reasoningOutputComplete: true,
      };
      entry.totalTokens += increment;
      entry.inputTokens += inputCounter.increment;
      entry.cachedInputTokens += cachedCounter.increment;
      entry.outputTokens += outputCounter.increment;
      entry.reasoningOutputTokens += reasoningCounter.increment;
      entry.inputOutputComplete =
        entry.inputOutputComplete && hasInput && hasOutput;
      entry.cachedInputComplete =
        entry.cachedInputComplete && hasCachedInput;
      entry.reasoningOutputComplete =
        entry.reasoningOutputComplete && hasReasoningOutput;
      modelTotals.set(model, entry);
    }
  }

  const hasInputOutput =
    inputOutputComplete && inputTokens + outputTokens === totalTokens;
  const hasCachedInput =
    hasInputOutput &&
    cachedInputComplete &&
    cachedInputTokens <= inputTokens;
  const hasReasoningOutput =
    hasInputOutput &&
    reasoningOutputComplete &&
    reasoningOutputTokens <= outputTokens;
  return {
    totalTokens,
    ...(hasInputOutput ? { inputTokens, outputTokens } : {}),
    ...(hasCachedInput ? { cachedInputTokens } : {}),
    ...(hasReasoningOutput ? { reasoningOutputTokens } : {}),
    sessionCount: countedSessions.size,
    models: Array.from(modelTotals, ([label, entry]) => {
      const modelHasInputOutput =
        entry.inputOutputComplete &&
        entry.inputTokens + entry.outputTokens === entry.totalTokens;
      const modelHasCachedInput =
        modelHasInputOutput &&
        entry.cachedInputComplete &&
        entry.cachedInputTokens <= entry.inputTokens;
      const modelHasReasoningOutput =
        modelHasInputOutput &&
        entry.reasoningOutputComplete &&
        entry.reasoningOutputTokens <= entry.outputTokens;
      return {
        id: `codex-log-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        label,
        estimatedTokens: entry.totalTokens,
        ...(modelHasInputOutput
          ? {
              inputTokens: entry.inputTokens,
              outputTokens: entry.outputTokens,
            }
          : {}),
        ...(modelHasCachedInput
          ? { cachedInputTokens: entry.cachedInputTokens }
          : {}),
        ...(modelHasReasoningOutput
          ? { reasoningOutputTokens: entry.reasoningOutputTokens }
          : {}),
        countedInTotal: true,
      };
    }).sort((left, right) => right.estimatedTokens - left.estimatedTokens),
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
    reasoningOutputTokens: summary.reasoningOutputTokens,
    periodSeconds,
    periodStartAt: new Date(sinceMs).toISOString(),
    sessionCount: summary.sessionCount,
    models: summary.models,
    assumption: coverageNote ? `${assumption} ${coverageNote}` : assumption,
  };
}

export async function estimateCodexSessionLogTokenEstimates(
  env = process.env,
  now = Date.now(),
) {
  if (/^(?:0|false|off|no)$/i.test(env.USAGE_HUB_CODEX_LOG_ESTIMATE || "")) {
    return [];
  }

  const fallbackSinceMs = now - WEEK_SECONDS * 1000;
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  const records = [];
  const pathsByRollout = new Map();
  const statByPath = new Map();
  const recentPaths = [];
  let coverageIncomplete = false;
  let oversizedLineCount = 0;

  for await (const path of jsonlFiles(join(codexHome, "sessions"))) {
    try {
      const metadata = await stat(path);
      pathsByRollout.set(rolloutIdForPath(path), path);
      statByPath.set(path, { size: metadata.size, mtimeMs: metadata.mtimeMs });
      if (metadata.mtimeMs >= fallbackSinceMs) recentPaths.push(path);
    } catch (error) {
      coverageIncomplete = true;
      if (error?.code !== "ENOENT") {
        console.warn(
          `Skipping unreadable Codex session log: ${basename(path)}`,
        );
      }
    }
  }

  // Recent fork files can replay an ancestor's token history with rewritten
  // timestamps. Load referenced ancestors even when their file mtime is older
  // than the reporting window so those states can be removed before daily or
  // weekly aggregation.
  lastScanHits = 0;
  lastScanMisses = 0;
  const pendingPaths = [...recentPaths];
  const readRollouts = new Set();
  const visitedPaths = new Set();
  while (pendingPaths.length) {
    const path = pendingPaths.pop();
    const rolloutId = rolloutIdForPath(path);
    if (readRollouts.has(rolloutId)) continue;
    readRollouts.add(rolloutId);
    try {
      const metadata = statByPath.get(path);
      const cached = fileCache.get(path);
      let result;
      if (
        cached &&
        metadata &&
        cached.size === metadata.size &&
        cached.mtimeMs === metadata.mtimeMs
      ) {
        lastScanHits += 1;
        result = cached.result;
      } else {
        lastScanMisses += 1;
        result = await readTokenCountRecords(path);
        // The size/mtime pair predates the read; if the file grew in
        // between, the next scan's stat differs from it and re-parses. The
        // stale direction (cache hit on changed content) cannot happen.
        if (metadata) {
          fileCache.set(path, { ...metadata, result });
        }
      }
      visitedPaths.add(path);
      for (const record of result.records) records.push(record);
      oversizedLineCount += result.oversizedLines;
      if (
        result.parentRolloutId &&
        !readRollouts.has(result.parentRolloutId) &&
        pathsByRollout.has(result.parentRolloutId)
      ) {
        pendingPaths.push(pathsByRollout.get(result.parentRolloutId));
      } else if (
        result.parentRolloutId &&
        !pathsByRollout.has(result.parentRolloutId)
      ) {
        coverageIncomplete = true;
      }
    } catch (error) {
      fileCache.delete(path);
      coverageIncomplete = true;
      if (error?.code !== "ENOENT") {
        console.warn(
          `Skipping unreadable Codex session log: ${basename(path)}`,
        );
      }
    }
  }

  // Drop cache entries for files this scan did not visit (aged out of the
  // window without a fork child referencing them, or deleted) so cache
  // memory stays bounded by the reporting window.
  for (const path of fileCache.keys()) {
    if (!visitedPaths.has(path)) fileCache.delete(path);
  }
  const firstRecordByRollout = new Map();
  for (const record of records) {
    const rolloutId = record.rolloutId || record.sessionId;
    if (!firstRecordByRollout.has(rolloutId)) {
      firstRecordByRollout.set(rolloutId, record);
    }
  }
  coverageIncomplete =
    coverageIncomplete ||
    Array.from(firstRecordByRollout.values()).some((record) => {
      const total = finiteTokenCount(record.totalTokens);
      const last = finiteTokenCount(record.lastTokens);
      return (
        record.inheritedCounter === null &&
        total !== null &&
        last !== null &&
        total > last * INHERITED_COUNTER_RATIO
      );
    });

  // Align the window with the subscription quota cycle: token_count events
  // embed the current weekly rate-limit window (the provider has used both
  // primary and secondary slots across versions), so the latest one pins the
  // subscription cycle. Reject an already-ended window, then fall back to
  // now-7d.
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
    if (startMs <= now && alignedWindow.resetsAtMs > now) {
      sinceMs = startMs;
      periodSeconds = alignedWindow.windowSeconds;
    }
  }

  const coverageNote =
    [
      coverageIncomplete
        ? "Some logs or ancestor rollouts could not be fully read, so this is marked as approximate."
        : "",
      oversizedLineCount > 0
        ? "Log lines longer than 4MB were skipped as corrupted, so this is marked as approximate."
        : "",
    ]
      .filter(Boolean)
      .join(" ") || null;

  const todaySinceMs = localDayStartMs(now);
  const todaySeconds = Math.max(
    60,
    Math.round((now - todaySinceMs) / 1000),
  );
  const today = sessionLogEstimate(
    summarizeTokenCountRecords(records, todaySinceMs, now),
    todaySinceMs,
    todaySeconds,
    "today",
    "Counts only this machine's Codex token_count deltas since local midnight; total = input (incl. cached input) + output, where cached input and reasoning output are subsets of input and output and are not added twice; prompts and response bodies are never read or uploaded.",
    coverageNote,
  );
  const weeklyCycle = sessionLogEstimate(
    summarizeTokenCountRecords(records, sinceMs, now),
    sinceMs,
    periodSeconds,
    "weekly_cycle",
    "Counts only this machine's Codex session logs, accumulating token_count deltas over the subscription cycle window (aligned with the quota API's weekly window, falling back to the past 7 days when unavailable); total = input (incl. cached input) + output; usage from other devices is not included.",
    coverageNote,
  );
  return [today, weeklyCycle].filter(Boolean);
}

export async function estimateCodexSessionLogTokens(
  env = process.env,
  now = Date.now(),
) {
  const estimates = await estimateCodexSessionLogTokenEstimates(env, now);
  if (!estimates.length) return null;
  return (
    estimates.find((estimate) => estimate.periodId === "weekly_cycle") ||
    estimates[0] ||
    null
  );
}
