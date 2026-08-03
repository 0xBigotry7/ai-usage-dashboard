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

export function isProviderStale(provider: Provider) {
  const updatedAt = new Date(provider.updatedAt).getTime();
  const staleAfterMs =
    provider.id === "claude"
      ? CLAUDE_STALE_AFTER_MS
      : PROVIDER_STALE_AFTER_MS;
  return (
    !Number.isFinite(updatedAt) ||
    Date.now() - updatedAt > staleAfterMs
  );
}

export function providerStateLabel(provider: Provider) {
  if (isProviderStale(provider)) return "Data stale";
  switch (provider.state) {
    case "ready":
      return "Live";
    case "needs_configuration":
      return "Needs setup";
    case "auth_error":
      return "Sign-in required";
    default:
      return "Connection error";
  }
}

export function getPrimaryWindow(provider: Provider) {
  return (
    provider.windows.find((window) => window.id === "weekly") ||
    provider.windows[provider.windows.length - 1] ||
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
  if (window.durationSeconds === null) {
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
  generatedAt: number,
) {
  // A reset that already passed must not stay pinned as "next".
  const threshold = Math.max(generatedAt, Date.now());
  return resets
    .filter(
      (reset) =>
        reset.resetsAt && new Date(reset.resetsAt).getTime() > threshold,
    )
    .sort(
      (a, b) =>
        new Date(a.resetsAt || 0).getTime() -
        new Date(b.resetsAt || 0).getTime(),
    )[0];
}
