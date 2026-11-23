/**
 * Pure read-model helpers over the sanitized usage payload: staleness and
 * risk classification, window/token-estimate selection, and reset resolution.
 */
import { estimateNextResetAt } from "./reset-estimate";
import type {
  HistoryPoint,
  Provider,
  TokenUsage,
  WindowUsage,
} from "./usage-types";

const PROVIDER_STALE_AFTER_MS = 10 * 60 * 1000;
const CLAUDE_STALE_AFTER_MS = 45 * 60 * 1000;

/** Past its reset time, or past the end of a day-only reset date. */
export function isWindowExpired(window: WindowUsage, now = Date.now()) {
  if (window.resetDate) {
    const dayAfter = new Date(`${window.resetDate}T00:00:00`);
    dayAfter.setDate(dayAfter.getDate() + 1);
    return dayAfter.getTime() <= now;
  }
  return window.resetsAt ? Date.parse(window.resetsAt) <= now : false;
}

/**
 * Same rule as the menu bar app (UsageMenuBarApp.swift) and the widget feed
 * (collector/desktop-preferences.mjs); keep the three in step. Callers pass
 * a ticking `now` so a card turns stale even when no new data arrives.
 */
export function isProviderStale(provider: Provider, now = Date.now()) {
  // A reading taken before its window reset describes the last cycle.
  const primary = getPrimaryWindow(provider);
  if (primary && isWindowExpired(primary, now)) return true;
  // A manual snapshot stays valid until its window ends.
  if (provider.sourceKind === "manual") return false;
  const updatedAt = new Date(provider.updatedAt).getTime();
  const staleAfterMs = provider.id.startsWith("claude")
    ? CLAUDE_STALE_AFTER_MS
    : PROVIDER_STALE_AFTER_MS;
  return !Number.isFinite(updatedAt) || now - updatedAt > staleAfterMs;
}

export type ProviderHealth = "live" | "stale" | "unavailable";

/** A source that is not ready is never live, however recent its timestamp. */
export function providerHealth(
  provider: Provider,
  now = Date.now(),
): ProviderHealth {
  if (provider.state !== "ready") return "unavailable";
  return isProviderStale(provider, now) ? "stale" : "live";
}

/** "4 live · 1 stale · 2 unavailable", leaving out the empty groups. */
export function healthSummary(providers: Provider[], now = Date.now()) {
  const counts = { live: 0, stale: 0, unavailable: 0 };
  for (const provider of providers) counts[providerHealth(provider, now)] += 1;
  return {
    ...counts,
    text: (["live", "stale", "unavailable"] as const)
      .filter((health) => counts[health] > 0)
      .map((health) => `${counts[health]} ${health}`)
      .join(" · "),
  };
}

export function providerStateLabel(provider: Provider, now = Date.now()) {
  switch (provider.state) {
    case "ready":
      if (isProviderStale(provider, now)) return "Data stale";
      return provider.sourceKind === "manual" ? "Manual snapshot" : "Live";
    case "needs_configuration":
      return provider.sourceKind === "manual" ? "Awaiting entry" : "Needs setup";
    case "auth_error":
      return "Sign-in required";
    default:
      return "Connection error";
  }
}

/** Weekly when it has a reading, otherwise the last window that has one. */
export function getPrimaryWindow(provider: Provider) {
  const withReading = provider.windows.filter(
    (window) => window.usedPercent !== null,
  );
  return (
    withReading.find((window) => window.id === "weekly") ||
    withReading[withReading.length - 1] ||
    null
  );
}

export function getPeakWindow(provider: Provider) {
  return provider.windows
    .filter(
      (window): window is WindowUsage & { usedPercent: number } =>
        window.usedPercent !== null,
    )
    .sort((left, right) => right.usedPercent - left.usedPercent)[0] || null;
}

export function getTokenEstimates(provider: Provider) {
  if (provider.tokenEstimates?.length) return provider.tokenEstimates;
  return provider.tokenUsage ? [provider.tokenUsage] : [];
}

export function tokenBasisLabel(basis: TokenUsage["basis"]) {
  if (basis === "quota_percentage") return "quota percentage conversion";
  if (basis === "api_usage") return "official API usage";
  return "local CLI logs";
}

export function tokenPeriodLabel(usage: TokenUsage) {
  if (usage.periodId === "today") return "Today";
  if (usage.periodId === "weekly_cycle") return "Subscription cycle";
  if (usage.periodId === "weekly_quota") return "Weekly quota";
  if (usage.periodId === "rolling_7d") return "Past 7 days";
  return usage.basis === "quota_percentage" ? "Weekly quota" : "Reporting period";
}

export function tokenScopeLabel(usage: TokenUsage) {
  if (usage.scope === "account" || usage.basis === "api_usage") {
    return "account-wide";
  }
  if (
    usage.scope === "calibrated_quota" ||
    usage.basis === "quota_percentage"
  ) {
    return "calibrated capacity";
  }
  return "this device only";
}

export function providerRisk(
  provider: Provider,
  warningThreshold: number,
): "normal" | "warning" | "critical" {
  const percent = getPeakWindow(provider)?.usedPercent;
  if (percent === null || percent === undefined) return "normal";
  if (percent >= Math.min(95, warningThreshold + 20)) return "critical";
  if (percent >= warningThreshold) return "warning";
  return "normal";
}

export function normalizeBars(points: HistoryPoint[], provider: Provider) {
  const primary = getPrimaryWindow(provider);
  if (!primary) return [];
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const samples = points.filter(
    (point) =>
      point.providerId === provider.id &&
      point.windowId === primary.id &&
      point.usedPercent !== null &&
      new Date(point.capturedAt).getTime() >= dayAgo,
  );
  const compacted = samples.length > 22
    ? samples.filter((_, index) => index % Math.ceil(samples.length / 22) === 0)
    : samples;
  return compacted.length > 1
    ? compacted.slice(-22).map((point) => point.usedPercent || 0)
    : [];
}

export function getPreferredTokenEstimate(estimates: TokenUsage[]) {
  return (
    estimates.find(
      (estimate) =>
        estimate.basis === "session_logs" && estimate.periodId === "today",
    ) ||
    estimates.find(
      (estimate) =>
        estimate.basis === "api_usage" && estimate.periodId === "today",
    ) ||
    estimates.find((estimate) => estimate.basis === "api_usage") ||
    estimates.find(
      (estimate) =>
        estimate.basis === "session_logs" &&
        estimate.periodId === "weekly_cycle",
    ) ||
    estimates.find((estimate) => estimate.basis === "session_logs") ||
    estimates.find((estimate) => estimate.basis === "quota_percentage") ||
    null
  );
}

export function getPreferredTokenUsage(provider: Provider) {
  return (
    provider.tokenUsage ||
    getPreferredTokenEstimate(getTokenEstimates(provider))
  );
}

export type ResolvedReset = {
  resetsAt: string | null;
  estimated: boolean;
};

/** Lookup of resolved resets built once per payload; see buildResetLookup. */
export type ResetLookup = ReadonlyMap<string, ResolvedReset>;

const NO_RESET: ResolvedReset = { resetsAt: null, estimated: false };

function resolveReset(
  providerId: Provider["id"],
  window: WindowUsage | undefined | null,
  history: HistoryPoint[],
): ResolvedReset {
  if (!window) return NO_RESET;
  if (window.resetsAt) {
    return { resetsAt: window.resetsAt, estimated: false };
  }
  if (providerId === "antigravity" || window.resetDate || window.durationSeconds === null) {
    return NO_RESET;
  }
  const resetsAt = estimateNextResetAt({
    providerId,
    windowId: window.id,
    durationSeconds: window.durationSeconds,
    history,
  });
  return {
    resetsAt,
    estimated: resetsAt !== null,
  };
}

/**
 * Resolves the reset for every window of every provider exactly once, so
 * cards, the next-reset overview, and the copy summary all read the same
 * precomputed values instead of re-deriving them from history.
 */
export function buildResetLookup(
  providers: Provider[],
  history: HistoryPoint[],
): ResetLookup {
  const resets = new Map<string, ResolvedReset>();
  for (const provider of providers) {
    for (const window of provider.windows) {
      resets.set(
        `${provider.id}:${window.id}`,
        resolveReset(provider.id, window, history),
      );
    }
  }
  return resets;
}

export function lookupReset(
  resets: ResetLookup,
  providerId: Provider["id"],
  window: WindowUsage | undefined | null,
): ResolvedReset {
  if (!window) return NO_RESET;
  return resets.get(`${providerId}:${window.id}`) || NO_RESET;
}

export function pickNextReset<T extends { resetsAt: string | null }>(
  resets: T[],
  now: number,
) {
  return resets
    .filter(
      (reset) =>
        reset.resetsAt && new Date(reset.resetsAt).getTime() > now,
    )
    .sort(
      (a, b) =>
        new Date(a.resetsAt || 0).getTime() -
        new Date(b.resetsAt || 0).getTime(),
    )[0];
}
