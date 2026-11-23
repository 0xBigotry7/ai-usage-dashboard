import { clampPercent, durationToWindow, readJson, toIsoTime } from "./shared.mjs";

const durations = { five_hour: 18_000, seven_day: 604_800 };

export function claudeSubscriptionLimits(rateLimits, now = Date.now()) {
  const limits = {};
  for (const id of Object.keys(durations)) {
    const entry = rateLimits?.[id];
    const used = entry?.used_percentage;
    const reset = entry?.resets_at;
    if (Number.isFinite(used) && used >= 0 && used <= 100 &&
        Number.isSafeInteger(reset) && reset * 1_000 > now && toIsoTime(reset)) {
      limits[id] = { used_percentage: used, resets_at: reset };
    }
  }
  return limits;
}

export async function readClaudeQuota(path, now = Date.now()) {
  if (!path) return null;
  let snapshot;
  try {
    snapshot = await readJson(path);
  } catch {
    return null;
  }

  const capturedAt = toIsoTime(snapshot?.capturedAt);
  if (!capturedAt || Date.parse(capturedAt) > now) return null;

  const limits = claudeSubscriptionLimits(snapshot?.rateLimits, now);
  const windows = Object.entries(limits).map(([id, limit]) => ({
    ...durationToWindow(durations[id]),
    usedPercent: clampPercent(limit.used_percentage),
    used: null,
    limit: null,
    remaining: null,
    resetsAt: toIsoTime(limit.resets_at),
  }));
  return windows.length > 0 ? { capturedAt, windows } : null;
}
