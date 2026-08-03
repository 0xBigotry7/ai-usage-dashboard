"use client";

import Link from "next/link";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { version as DASHBOARD_VERSION } from "../package.json";
import { estimateNextResetAt } from "../lib/reset-estimate";
import { ProviderLogo } from "./provider-logo";

type WindowUsage = {
  id: string;
  label: string;
  durationSeconds: number | null;
  usedPercent: number | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null;
};

type ModelTokenUsage = {
  id: string;
  label: string;
  windowId?: string;
  usedPercent?: number;
  capacityTokens?: number;
  estimatedTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  requestCount?: number;
  countedInTotal: boolean;
};

type TokenUsage = {
  basis: "quota_percentage" | "session_logs" | "api_usage";
  periodId?: "today" | "weekly_cycle" | "rolling_7d" | "weekly_quota";
  scope?: "local_device" | "account" | "calibrated_quota";
  estimated: boolean;
  totalTokens: number;
  capacityTokens?: number;
  usedPercent?: number;
  windowId?: string;
  periodSeconds?: number;
  periodStartAt?: string | null;
  sessionCount?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  requestCount?: number;
  models: ModelTokenUsage[];
  assumption: string;
};

type Provider = {
  id: string;
  name: string;
  shortName: string;
  accent: string;
  state: "ready" | "needs_configuration" | "auth_error" | "error";
  plan: string | null;
  source: string;
  sourceKind?: string;
  updatedAt: string;
  windows: WindowUsage[];
  balance: {
    label: string;
    value: number;
    unit: string;
  } | null;
  message: string | null;
  tokenUsage: TokenUsage | null;
  tokenEstimates?: TokenUsage[];
};

type UsagePayload = {
  generatedAt: string;
  collector: {
    host?: string;
    version: string;
    state: "online" | "attention" | "starting";
    startedAt: string | null;
  };
  providers: Provider[];
};

type HistoryPoint = {
  providerId: string;
  windowId: string;
  usedPercent: number | null;
  capturedAt: string;
};

const REFRESH_SECONDS = 60;
const PROVIDER_STALE_AFTER_MS = 10 * 60 * 1000;
const CLAUDE_STALE_AFTER_MS = 45 * 60 * 1000;
const PREFERENCE_KEY = "ai-usage-dashboard.preferences.v1";
const WARNING_LEVELS = [60, 70, 80];

type DashboardPreferences = {
  warningThreshold: number;
  hiddenProviders: string[];
};

function getApiBase() {
  if (typeof window === "undefined") return "";
  return window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:4317"
    : "";
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number | null) {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function formatNumber(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value % 1 ? 1 : 0,
  }).format(value);
}

function formatTokens(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(value);
}

function exactTokens(value: number) {
  return `${new Intl.NumberFormat(undefined).format(value)} tokens`;
}

function formatBalance(value: number, unit: string) {
  const normalizedUnit = unit.toUpperCase();
  const prefix =
    normalizedUnit === "USD" ? "$" : normalizedUnit === "CNY" ? "¥" : "";
  const suffix =
    prefix || !normalizedUnit || normalizedUnit === "CREDITS"
      ? ""
      : ` ${normalizedUnit}`;
  return `${prefix}${formatNumber(value)}${suffix}`;
}

function formatCountdown(resetsAt: string | null) {
  if (!resetsAt) return "no reset time provided";
  const difference = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(difference)) return "reset time unknown";
  if (difference <= 0) return "awaiting refresh";
  const minutes = Math.max(1, Math.floor(difference / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const restMinutes = minutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${restMinutes}m`;
  return `in ${restMinutes}m`;
}

function formatResetClock(resetsAt: string | null) {
  if (!resetsAt) return "time unknown";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(resetsAt));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
}

function formatUpdated(value: string | null) {
  if (!value) return "not connected yet";
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatAge(value: string | null) {
  if (!value) return "time unknown";
  const ageMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ageMs)) return "unknown";
  if (ageMs < 0) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function isProviderStale(provider: Provider) {
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

function providerStateLabel(provider: Provider) {
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

function getPrimaryWindow(provider: Provider) {
  return (
    provider.windows.find((window) => window.id === "weekly") ||
    provider.windows[provider.windows.length - 1] ||
    null
  );
}

function getPeakWindow(provider: Provider) {
  return provider.windows
    .filter(
      (window): window is WindowUsage & { usedPercent: number } =>
        window.usedPercent !== null,
    )
    .sort((left, right) => right.usedPercent - left.usedPercent)[0] || null;
}

function getTokenEstimates(provider: Provider) {
  if (provider.tokenEstimates?.length) return provider.tokenEstimates;
  return provider.tokenUsage ? [provider.tokenUsage] : [];
}

function tokenBasisLabel(basis: TokenUsage["basis"]) {
  if (basis === "quota_percentage") return "quota percentage conversion";
  if (basis === "api_usage") return "official API usage";
  return "local CLI logs";
}

function tokenPeriodLabel(usage: TokenUsage) {
  if (usage.periodId === "today") return "Today";
  if (usage.periodId === "weekly_cycle") return "Subscription cycle";
  if (usage.periodId === "weekly_quota") return "Weekly quota";
  if (usage.periodId === "rolling_7d") return "Past 7 days";
  return usage.basis === "quota_percentage" ? "Weekly quota" : "Reporting period";
}

function tokenScopeLabel(usage: TokenUsage) {
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

function tokenEstimateKey(usage: TokenUsage, index: number) {
  return [
    usage.basis,
    usage.periodId || usage.windowId || "unspecified",
    usage.scope || "unspecified",
    index,
  ].join(":");
}

function providerRisk(
  provider: Provider,
  warningThreshold: number,
): "normal" | "warning" | "critical" {
  const percent = getPeakWindow(provider)?.usedPercent;
  if (percent === null || percent === undefined) return "normal";
  if (percent >= Math.min(95, warningThreshold + 20)) return "critical";
  if (percent >= warningThreshold) return "warning";
  return "normal";
}

function normalizeBars(points: HistoryPoint[], provider: Provider) {
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

function getPreferredTokenEstimate(estimates: TokenUsage[]) {
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

function getPreferredTokenUsage(provider: Provider) {
  return (
    provider.tokenUsage ||
    getPreferredTokenEstimate(getTokenEstimates(provider))
  );
}

function resolveReset(
  providerId: Provider["id"],
  window: WindowUsage | undefined | null,
  history: HistoryPoint[],
) {
  if (!window) return { resetsAt: null, estimated: false };
  if (window.resetsAt) {
    return { resetsAt: window.resetsAt, estimated: false };
  }
  if (window.durationSeconds === null) {
    return { resetsAt: null, estimated: false };
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

function pickNextReset<T extends { resetsAt: string | null }>(
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

function WindowRow({
  window,
  reset,
}: {
  window: WindowUsage;
  reset: ReturnType<typeof resolveReset>;
}) {
  const percent = window.usedPercent ?? 0;
  return (
    <div className="window-row">
      <div className="window-row__top">
        <div>
          <span className="window-row__label">{window.label}</span>
          <span className="window-row__reset">
            {reset.estimated && reset.resetsAt ? "est. " : ""}
            {formatCountdown(reset.resetsAt)}
          </span>
        </div>
        <span className="window-row__percent">
          {formatPercent(window.usedPercent)}
        </span>
      </div>
      <div
        className="meter"
        role="progressbar"
        aria-label={`${window.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent ?? undefined}
      >
        <span style={{ width: `${clamp(percent)}%` }} />
      </div>
      <div className="window-row__detail">
        <span>
          Resets {reset.estimated && reset.resetsAt ? "~" : ""}
          {formatResetClock(reset.resetsAt)}
          {reset.estimated && reset.resetsAt ? " · estimated from history" : ""}
        </span>
        {window.limit !== null ? (
          <span>
            {formatNumber(window.used)} / {formatNumber(window.limit)}
          </span>
        ) : (
          <span>Provider-reported quota</span>
        )}
      </div>
    </div>
  );
}

function TokenComposition({
  inputTokens,
  outputTokens,
  cachedInputTokens,
  reasoningOutputTokens,
  compact = false,
}: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  compact?: boolean;
}) {
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number"
  ) {
    return null;
  }
  return (
    <div className={`token-composition ${compact ? "token-composition--compact" : ""}`}>
      <div aria-label="Total equals input plus output">
        <span>
          Input <b title={exactTokens(inputTokens)}>{formatTokens(inputTokens)}</b>
        </span>
        <i aria-hidden="true">+</i>
        <span>
          Output <b title={exactTokens(outputTokens)}>{formatTokens(outputTokens)}</b>
        </span>
        <i aria-hidden="true">=</i>
        <span>Total</span>
      </div>
      {!compact &&
      (typeof cachedInputTokens === "number" ||
        typeof reasoningOutputTokens === "number") ? (
        <small>
          {typeof cachedInputTokens === "number"
            ? `incl. cached input ${formatTokens(cachedInputTokens)}`
            : ""}
          {typeof cachedInputTokens === "number" &&
          typeof reasoningOutputTokens === "number"
            ? " · "
            : ""}
          {typeof reasoningOutputTokens === "number"
            ? `incl. reasoning output ${formatTokens(reasoningOutputTokens)}`
            : ""}
          {" · "}cached input and reasoning output are subsets, not added twice
        </small>
      ) : null}
    </div>
  );
}

function tokenUsageContext(usage: TokenUsage) {
  if (usage.basis === "quota_percentage") {
    return usage.capacityTokens
      ? `${formatPercent(usage.usedPercent ?? null)} × ${formatTokens(
          usage.capacityTokens,
        )} · ${tokenScopeLabel(usage)}`
      : "No capacity calibration configured; showing quota percentage only";
  }
  const period = `${tokenPeriodLabel(usage)}${
    usage.periodStartAt && usage.periodId !== "today"
      ? ` (since ${formatShortDate(usage.periodStartAt)})`
      : ""
  }`;
  const activity =
    usage.basis === "api_usage"
      ? `${formatNumber(usage.requestCount ?? 0)} requests`
      : `${formatNumber(usage.sessionCount ?? 0)} sessions`;
  return `${period} · ${tokenScopeLabel(usage)} · ${activity}`;
}

function tokenUsageOrder(usage: TokenUsage) {
  if (usage.periodId === "today" && usage.basis !== "quota_percentage") return 0;
  if (usage.periodId === "weekly_cycle" && usage.basis !== "quota_percentage") {
    return 1;
  }
  if (usage.basis === "api_usage") return 2;
  if (usage.basis === "quota_percentage") return 3;
  return 4;
}

function ProviderTokenPanel({
  estimates,
  preferred,
}: {
  estimates: TokenUsage[];
  preferred: TokenUsage | null;
}) {
  const matchesPreferred = (usage: TokenUsage) =>
    usage === preferred ||
    Boolean(
      preferred &&
        usage.basis === preferred.basis &&
        usage.periodId === preferred.periodId &&
        usage.scope === preferred.scope &&
        usage.totalTokens === preferred.totalTokens,
    );
  const orderedEstimates = [...estimates].sort(
    (left, right) => tokenUsageOrder(left) - tokenUsageOrder(right),
  );
  return (
    <section className="token-panel" aria-label="Token usage layers">
      <div className="token-panel__heading">
        <span className="eyebrow">Token usage · layered views</span>
        <small>Observed logs and quota conversions are never summed</small>
      </div>
      <div className="token-methods">
        {orderedEstimates.map((usage, index) => (
          <article
            className={`token-method token-method--${usage.periodId || usage.basis}`}
            key={tokenEstimateKey(usage, index)}
          >
            <header>
              <div>
                <span>
                  {tokenPeriodLabel(usage)} · {tokenBasisLabel(usage.basis)}
                  {matchesPreferred(usage) ? " · shown in quick view" : ""}
                </span>
                {usage.basis === "quota_percentage" &&
                !usage.capacityTokens ? (
                  <strong>{formatPercent(usage.usedPercent ?? null)}</strong>
                ) : (
                  <strong title={exactTokens(usage.totalTokens)}>
                    {usage.estimated ? "≈" : ""}
                    {formatTokens(usage.totalTokens)}
                  </strong>
                )}
              </div>
              <small>{tokenUsageContext(usage)}</small>
            </header>
            <TokenComposition
              inputTokens={usage.inputTokens}
              outputTokens={usage.outputTokens}
              cachedInputTokens={usage.cachedInputTokens}
              reasoningOutputTokens={usage.reasoningOutputTokens}
            />
            <div className="token-models">
              {usage.models.map((model) => (
                <div className="token-model" key={model.id}>
                  <div>
                    <span>{model.label}</span>
                    <small>
                      {usage.basis === "quota_percentage"
                        ? `${formatPercent(
                            model.usedPercent ?? null,
                          )} × ${formatTokens(
                            model.capacityTokens ?? null,
                          )} weekly capacity`
                        : usage.basis === "api_usage"
                          ? `${formatNumber(
                              model.requestCount ?? 0,
                            )} official API requests`
                          : "token_count deltas"}
                      {model.countedInTotal
                        ? ""
                        : " · separate quota, not counted in total"}
                    </small>
                    <TokenComposition
                      compact
                      inputTokens={model.inputTokens}
                      outputTokens={model.outputTokens}
                      cachedInputTokens={model.cachedInputTokens}
                      reasoningOutputTokens={model.reasoningOutputTokens}
                    />
                  </div>
                  <strong title={exactTokens(model.estimatedTokens)}>
                    {usage.estimated ? "≈" : ""}
                    {formatTokens(model.estimatedTokens)}
                  </strong>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

type TokenOverviewEntry = {
  provider: Provider;
  usage: TokenUsage;
};

function findRecordedUsage(
  provider: Provider,
  periodId: "today" | "weekly_cycle",
) {
  const matches = getTokenEstimates(provider).filter(
    (usage) =>
      usage.periodId === periodId &&
      (usage.basis === "session_logs" || usage.basis === "api_usage"),
  );
  return (
    matches.find((usage) => usage.basis === "api_usage") ||
    matches.find((usage) => usage.basis === "session_logs") ||
    null
  );
}

function recordedEntries(
  providers: Provider[],
  periodId: "today" | "weekly_cycle",
) {
  return providers
    .map((provider) => ({
      provider,
      usage: findRecordedUsage(provider, periodId),
    }))
    .filter(
      (entry): entry is TokenOverviewEntry => Boolean(entry.usage),
    );
}

function tokenEntriesTotal(entries: TokenOverviewEntry[]) {
  return entries.reduce((sum, { usage }) => sum + usage.totalTokens, 0);
}

function recordedCoverage(
  entries: TokenOverviewEntry[],
  providers: Provider[],
) {
  if (!entries.length) return "No observed token records for this period yet";
  const covered = entries
    .map(({ provider, usage }) => `${provider.name} · ${tokenScopeLabel(usage)}`)
    .join("; ");
  const coveredIds = new Set(entries.map(({ provider }) => provider.id));
  const missing = providers
    .filter((provider) => !coveredIds.has(provider.id))
    .map((provider) => provider.name);
  return `${covered}${
    missing.length ? `; no observed data for ${missing.join(", ")}` : ""
  }`;
}

function overviewComposition(entries: TokenOverviewEntry[]) {
  if (
    !entries.length ||
    !entries.every(
      ({ usage }) =>
        typeof usage.inputTokens === "number" &&
        typeof usage.outputTokens === "number",
    )
  ) {
    return null;
  }
  return {
    inputTokens: entries.reduce(
      (sum, { usage }) => sum + (usage.inputTokens || 0),
      0,
    ),
    outputTokens: entries.reduce(
      (sum, { usage }) => sum + (usage.outputTokens || 0),
      0,
    ),
  };
}

function TokenOverview({ providers }: { providers: Provider[] }) {
  const todayEntries = recordedEntries(providers, "today");
  const weeklyEntries = recordedEntries(providers, "weekly_cycle");
  const quotaEntries = providers
    .map((provider) => ({
      provider,
      usage:
        getTokenEstimates(provider).find(
          (usage) => usage.basis === "quota_percentage",
        ) || null,
    }))
    .filter(
      (entry): entry is TokenOverviewEntry =>
        Boolean(
          entry.usage &&
            typeof entry.usage.capacityTokens === "number" &&
            entry.usage.capacityTokens > 0,
        ),
    );
  const todayComposition = overviewComposition(todayEntries);
  const weeklyComposition = overviewComposition(weeklyEntries);
  const layers = [
    {
      id: "today",
      label: "Tokens recorded today",
      total: tokenEntriesTotal(todayEntries),
      entries: todayEntries,
      composition: todayComposition,
      caption: recordedCoverage(todayEntries, providers),
      estimated: todayEntries.some(({ usage }) => usage.estimated),
    },
    {
      id: "weekly",
      label: "Recorded this subscription cycle",
      total: tokenEntriesTotal(weeklyEntries),
      entries: weeklyEntries,
      composition: weeklyComposition,
      caption: recordedCoverage(weeklyEntries, providers),
      estimated: weeklyEntries.some(({ usage }) => usage.estimated),
    },
    {
      id: "quota",
      label: "Quota conversion",
      total: tokenEntriesTotal(quotaEntries),
      entries: quotaEntries,
      composition: null,
      caption: quotaEntries.length
        ? `${quotaEntries
            .map(({ provider }) => provider.name)
            .join(", ")} · percentage × calibrated capacity`
        : "No subscription capacity configured for conversion yet",
      estimated: true,
    },
  ];

  return (
    <section className="token-overview" aria-label="Token usage overview">
      <header className="token-overview__heading">
        <div>
          <span className="eyebrow">Token usage</span>
          <strong>Observed usage and quota estimates, kept separate</strong>
        </div>
        <small>Input + output = total; cache and reasoning are not double-counted</small>
      </header>
      <div className="token-overview__layers">
        {layers.map((layer) => (
          <article
            className={`token-overview__layer token-overview__layer--${layer.id}`}
            key={layer.id}
          >
            <span>{layer.label}</span>
            <strong
              title={
                layer.entries.length ? exactTokens(layer.total) : undefined
              }
            >
              {layer.entries.length
                ? `${layer.estimated ? "≈" : ""}${formatTokens(layer.total)}`
                : "Not available"}
            </strong>
            {layer.composition ? (
              <TokenComposition
                compact
                inputTokens={layer.composition.inputTokens}
                outputTokens={layer.composition.outputTokens}
              />
            ) : null}
            <small>{layer.caption}</small>
          </article>
        ))}
      </div>
      <p className="token-overview__note">
        The three layers are never summed: today and the subscription cycle come
        from logs or official records; quota conversion is only a capacity
        estimate, not observed tokens.
      </p>
    </section>
  );
}

// Owns the 1s ticker internally so the rest of the tree does not re-render
// every second; mount it with a `key` that changes when a load completes so
// the countdown restarts from the top.
function RefreshCountdown({ seconds }: { seconds: number }) {
  const [secondsLeft, setSecondsLeft] = useState(seconds);
  useEffect(() => {
    const timer = window.setInterval(
      () => setSecondsLeft((value) => (value <= 1 ? seconds : value - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [seconds]);
  return <>{secondsLeft}s</>;
}

const ProviderCard = memo(function ProviderCard({
  provider,
  history,
  warningThreshold,
}: {
  provider: Provider;
  history: HistoryPoint[];
  warningThreshold: number;
}) {
  const primary = getPrimaryWindow(provider);
  const fiveHour = provider.windows.find((window) => window.id === "five_hour");
  const primaryReset = resolveReset(provider.id, primary, history);
  const fiveHourReset = resolveReset(provider.id, fiveHour, history);
  const keyReset = fiveHour ? fiveHourReset : primaryReset;
  const bars = normalizeBars(history, provider);
  const isReady = provider.state === "ready";
  const risk = providerRisk(provider, warningThreshold);
  const peakWindow = getPeakWindow(provider);
  const stale = isProviderStale(provider);
  const hasQuota = primary?.usedPercent !== null && primary?.usedPercent !== undefined;

  return (
    <article
      className={`provider-card provider-card--${provider.id} provider-card--risk-${risk} ${stale ? "provider-card--stale" : ""}`}
      style={{ "--provider-accent": provider.accent } as React.CSSProperties}
    >
      <header className="provider-card__header">
        <div className="provider-identity">
          <ProviderLogo provider={provider} />
          <div>
            <h2>{provider.name}</h2>
            <p>{provider.plan || "Plan unknown"}</p>
          </div>
        </div>
        <span
          className={`state-pill state-pill--${provider.state} state-pill--risk-${risk} ${stale ? "state-pill--stale" : ""}`}
        >
          <i />
          {stale
            ? `Stale · ${formatAge(provider.updatedAt)}`
            : isReady && risk !== "normal" && peakWindow
              ? `${peakWindow.label} ${formatPercent(peakWindow.usedPercent)}`
              : providerStateLabel(provider)}
        </span>
      </header>

      <div className="provider-card__hero">
        <div
          className="usage-ring"
          style={{
            "--ring-value": `${clamp(primary?.usedPercent ?? 0) * 3.6}deg`,
          } as React.CSSProperties}
        >
          <div className="usage-ring__inside">
            <span>{formatPercent(primary?.usedPercent ?? null)}</span>
            <small>
              {hasQuota
                ? `${primary?.label || "current"} used`
                : "No quota window"}
            </small>
          </div>
        </div>
        <div className="provider-card__signal">
          <span className="eyebrow">Next key reset</span>
          <strong>
            {keyReset.resetsAt ? (
              <>
                {keyReset.estimated ? "est. " : ""}
                {formatCountdown(keyReset.resetsAt)}
              </>
            ) : (
              "No reset window"
            )}
          </strong>
          <p>
            {fiveHour
              ? `5-hour window · ${keyReset.estimated ? "~" : ""}${formatResetClock(keyReset.resetsAt)}`
              : primary
                ? `${primary.label} window · ${keyReset.estimated ? "~" : ""}${formatResetClock(keyReset.resetsAt)}`
                : "This source reports balance or model usage, not quota windows"}
          </p>
          {provider.balance ? (
            <div className="balance-chip">
              <span>{provider.balance.label}</span>
              <b>{formatBalance(provider.balance.value, provider.balance.unit)}</b>
            </div>
          ) : null}
        </div>
      </div>

      {isReady ? (
        <>
          {provider.message ? (
            <div className="provider-notice">
              <span aria-hidden="true">i</span>
              <p>{provider.message}</p>
            </div>
          ) : null}
          {provider.windows.length ? (
            <div className="window-list">
              {provider.windows.map((window) => (
                <WindowRow
                  key={window.id}
                  window={window}
                  reset={resolveReset(provider.id, window, history)}
                />
              ))}
            </div>
          ) : (
            <div className="metric-only-state">
              <span aria-hidden="true">↗</span>
              <p>
                This source reports balance or per-model stats; it has no
                subscription quota window to convert.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="provider-action">
          <span aria-hidden="true">!</span>
          <div>
            <strong>{providerStateLabel(provider)}</strong>
            <p>{provider.message}</p>
          </div>
        </div>
      )}

      {getTokenEstimates(provider).length ? (
        <ProviderTokenPanel
          estimates={getTokenEstimates(provider)}
          preferred={getPreferredTokenUsage(provider)}
        />
      ) : null}

      <footer className="provider-card__footer">
        <div>
          <span className="eyebrow">Past 24 hours</span>
          {bars.length > 1 ? (
            <div
              className="micro-bars"
              aria-label="Observed usage trend over the past 24 hours"
            >
              {bars.map((value, index) => (
                <i
                  key={`${index}-${value}`}
                  style={{ height: `${Math.max(8, value)}%` }}
                />
              ))}
            </div>
          ) : (
            <p className="history-pending">Collecting history</p>
          )}
        </div>
        <div className="source-meta">
          <span>{provider.source}</span>
          <small title={formatUpdated(provider.updatedAt)}>
            {formatAge(provider.updatedAt)}
          </small>
        </div>
      </footer>
    </article>
  );
});

function DisplayProviderTile({
  provider,
  history,
  warningThreshold,
}: {
  provider: Provider;
  history: HistoryPoint[];
  warningThreshold: number;
}) {
  const windows = provider.windows
    .filter((window) => window.usedPercent !== null)
    .slice(0, 3);
  const usage = getPreferredTokenUsage(provider);
  const models = usage?.models.slice(0, 2) || [];
  const risk = providerRisk(provider, warningThreshold);
  const stale = isProviderStale(provider);
  const peak = getPeakWindow(provider);

  return (
    <article
      className={`display-provider display-provider--${risk} ${stale ? "display-provider--stale" : ""}`}
      style={{ "--provider-accent": provider.accent } as React.CSSProperties}
    >
      <header className="display-provider__header">
        <div>
          <ProviderLogo provider={provider} className="provider-logo--display" />
          <span>
            <strong>{provider.name}</strong>
            <small>{provider.plan || providerStateLabel(provider)}</small>
          </span>
        </div>
        <span className="display-provider__state">
          {stale
            ? "STALE"
            : peak && risk !== "normal"
              ? `${peak.label} ${formatPercent(peak.usedPercent)}`
              : "LIVE"}
        </span>
      </header>

      {windows.length ? (
        <div className="display-windows">
          {windows.map((window) => {
            const reset = resolveReset(provider.id, window, history);
            return (
              <div className="display-window" key={window.id}>
                <span>{window.label}</span>
                <strong>{formatPercent(window.usedPercent)}</strong>
                <div
                  className="display-meter"
                  role="progressbar"
                  aria-label={`${provider.name} ${window.label} used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={window.usedPercent ?? undefined}
                >
                  <i style={{ width: `${clamp(window.usedPercent ?? 0)}%` }} />
                </div>
                <small>
                  {reset.estimated ? "est. " : ""}
                  {formatCountdown(reset.resetsAt)}
                </small>
              </div>
            );
          })}
        </div>
      ) : provider.balance ? (
        <div className="display-balance">
          <span>{provider.balance.label}</span>
          <strong>
            {formatBalance(provider.balance.value, provider.balance.unit)}
          </strong>
        </div>
      ) : (
        <div className="display-no-metric">
          <strong>{providerStateLabel(provider)}</strong>
          <span>
            {provider.message || "No displayable metrics from this source"}
          </span>
        </div>
      )}

      <footer className="display-provider__footer">
        {models.length && usage ? (
          <div className="display-models">
            {models.map((model) => (
              <div key={model.id}>
                <span>{model.label}</span>
                <strong>
                  {model.usedPercent !== undefined
                    ? `${formatPercent(model.usedPercent)} · `
                    : ""}
                  {usage.estimated ? "≈" : ""}
                  {formatTokens(model.estimatedTokens)}
                </strong>
              </div>
            ))}
          </div>
        ) : (
          <span className="display-models__empty">No per-model stats yet</span>
        )}
        <span className="display-provider__freshness">
          {formatAge(provider.updatedAt)}
        </span>
      </footer>
    </article>
  );
}

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
};

function DedicatedDisplay({
  data,
  providers,
  history,
  error,
  refreshSignal,
  warningThreshold,
  onRefresh,
}: {
  data: UsagePayload | null;
  providers: Provider[];
  history: HistoryPoint[];
  error: string | null;
  refreshSignal: number;
  warningThreshold: number;
  onRefresh: () => void;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(3);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const wakeLockWantedRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [clock, setClock] = useState("--:--");

  useEffect(() => {
    const updatePageSize = () => setPageSize(window.innerWidth >= 680 ? 4 : 3);
    updatePageSize();
    window.addEventListener("resize", updatePageSize);
    return () => window.removeEventListener("resize", updatePageSize);
  }, []);

  useEffect(() => {
    const updateClock = () =>
      setClock(
        new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date()),
      );
    updateClock();
    const timer = window.setInterval(updateClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const pageCount = Math.max(1, Math.ceil(providers.length / pageSize));
  const activePage = page % pageCount;
  const visible = providers.slice(
    activePage * pageSize,
    (activePage + 1) * pageSize,
  );

  useEffect(() => {
    if (pageCount <= 1) return;
    const timer = window.setInterval(
      () => setPage((value) => (value + 1) % pageCount),
      8_000,
    );
    return () => window.clearInterval(timer);
  }, [pageCount]);

  useEffect(() => {
    const handleFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreen);
  }, []);

  const acquireWakeLock = useCallback(async () => {
    const navigatorWithWakeLock = navigator as Navigator & {
      wakeLock?: {
        request: (type: "screen") => Promise<WakeLockSentinelLike>;
      };
    };
    if (!navigatorWithWakeLock.wakeLock) return false;
    try {
      const sentinel = await navigatorWithWakeLock.wakeLock.request("screen");
      wakeLockRef.current = sentinel;
      setWakeLockActive(true);
      // The browser can release the lock on its own (tab hidden, battery);
      // mirror that into state so the button never shows a dead lock.
      sentinel.addEventListener?.("release", () => {
        if (wakeLockRef.current === sentinel) {
          wakeLockRef.current = null;
          setWakeLockActive(false);
        }
      });
      return true;
    } catch {
      wakeLockRef.current = null;
      setWakeLockActive(false);
      return false;
    }
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        wakeLockWantedRef.current &&
        !wakeLockRef.current
      ) {
        void acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [acquireWakeLock]);

  useEffect(
    () => () => {
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      if (sentinel && !sentinel.released) void sentinel.release();
    },
    [],
  );

  async function toggleWakeLock() {
    if (wakeLockWantedRef.current) {
      wakeLockWantedRef.current = false;
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      setWakeLockActive(false);
      if (sentinel && !sentinel.released) await sentinel.release();
      return;
    }
    wakeLockWantedRef.current = await acquireWakeLock();
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  const staleCount = providers.filter(isProviderStale).length;
  return (
    <section className="dedicated-display" aria-label="External always-on display">
      <header className="display-header">
        <div className="display-brand">
          <span className="brand__signal" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>AI USAGE</strong>
            <small>
              {error
                ? "Collector offline"
                : staleCount
                  ? `${providers.length - staleCount} live · ${staleCount} stale`
                  : `${providers.length} providers live`}
            </small>
          </span>
        </div>
        <div className="display-clock">
          <strong>{clock}</strong>
          <small>
            refresh in{" "}
            <RefreshCountdown key={refreshSignal} seconds={REFRESH_SECONDS} />
          </small>
        </div>
        <nav className="display-actions" aria-label="Display controls">
          <button
            type="button"
            className={wakeLockActive ? "is-active" : ""}
            onClick={() => void toggleWakeLock()}
            title="Keep the screen awake"
          >
            Awake
          </button>
          <button type="button" onClick={() => void toggleFullscreen()}>
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
          <Link href="/">Dashboard</Link>
        </nav>
      </header>

      <div
        className="display-grid"
        aria-live="polite"
        style={
          {
            "--display-columns": Math.max(1, visible.length),
          } as React.CSSProperties
        }
      >
        {visible.length ? (
          visible.map((provider) => (
            <DisplayProviderTile
              key={provider.id}
              provider={provider}
              history={history}
              warningThreshold={warningThreshold}
            />
          ))
        ) : (
          <div className="display-empty">
            <strong>
              {error
                ? "Collector temporarily unavailable"
                : "Waiting for the first usage snapshot"}
            </strong>
            <span>
              {error ||
                "Data appears automatically when it arrives — no page refresh needed."}
            </span>
          </div>
        )}
      </div>

      <footer className="display-footer">
        <span>
          {data?.generatedAt
            ? `Snapshot ${formatAge(data.generatedAt)}`
            : "Connecting to local collector"}
        </span>
        {pageCount > 1 ? (
          <div aria-label="Provider pages">
            {Array.from({ length: pageCount }, (_, index) => (
              <button
                key={index}
                type="button"
                className={activePage === index ? "is-active" : ""}
                onClick={() => setPage(index)}
                aria-label={`Show page ${index + 1}`}
                aria-pressed={activePage === index}
              />
            ))}
          </div>
        ) : null}
        <span>Optimized for 480×320 · 800×480</span>
      </footer>
    </section>
  );
}

function LoadingCard({
  id,
  name,
  shortName,
  accent,
}: {
  id: string;
  name: string;
  shortName: string;
  accent: string;
}) {
  return (
    <article className="provider-card provider-card--loading" aria-busy="true">
      <header className="provider-card__header">
        <div className="provider-identity">
          <ProviderLogo provider={{ id, name, shortName, accent }} />
          <div>
            <h2>{name}</h2>
            <p>Reading live quota</p>
          </div>
        </div>
      </header>
      <div className="loading-lines">
        <span />
        <span />
        <span />
      </div>
    </article>
  );
}

export function UsageDashboard({
  displayMode = false,
}: {
  displayMode?: boolean;
} = {}) {
  const [data, setData] = useState<UsagePayload | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [locked, setLocked] = useState(false);
  const [viewCode, setViewCode] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [warningThreshold, setWarningThreshold] = useState(70);
  const [hiddenProviders, setHiddenProviders] = useState<string[]>([]);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const loadSequenceRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const lastLoadedAtRef = useRef(0);

  const load = useCallback(async (manual = false) => {
    // A slow older response must never overwrite a newer one: bump the
    // sequence, abort the in-flight fetch, and ignore superseded results.
    const sequence = ++loadSequenceRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    if (manual) setRefreshing(true);
    try {
      const apiBase = getApiBase();
      const isLocalCollector = apiBase.length > 0;
      const [usageResponse, historyResponse] = await Promise.all([
        manual && isLocalCollector
          ? fetch(`${apiBase}/api/refresh`, {
              method: "POST",
              signal: controller.signal,
            })
          : fetch(`${apiBase}/api/usage`, {
              cache: "no-store",
              signal: controller.signal,
            }),
        fetch(`${apiBase}/api/history?hours=168`, {
          cache: "no-store",
          signal: controller.signal,
        }),
      ]);
      if (sequence !== loadSequenceRef.current) return;
      if (usageResponse.status === 401 && !isLocalCollector) {
        setLocked(true);
        setData(null);
        setError(null);
        return;
      }
      if (!usageResponse.ok || !historyResponse.ok) {
        throw new Error("Usage service returned an error");
      }
      const [usagePayload, historyPayload] = await Promise.all([
        usageResponse.json() as Promise<UsagePayload>,
        historyResponse.json() as Promise<{
          points?: HistoryPoint[];
          truncated?: boolean;
        }>,
      ]);
      if (sequence !== loadSequenceRef.current) return;
      setData(usagePayload);
      setHistory(historyPayload.points || []);
      setHistoryTruncated(historyPayload.truncated === true);
      setLocked(false);
      setError(null);
      lastLoadedAtRef.current = Date.now();
      setRefreshSignal((value) => value + 1);
    } catch {
      if (sequence !== loadSequenceRef.current) return;
      setError("Cannot reach the usage collector right now. Try again shortly.");
    } finally {
      if (sequence === loadSequenceRef.current) setRefreshing(false);
    }
  }, []);

  async function unlock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!viewCode.trim()) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: viewCode }),
      });
      if (!response.ok) {
        throw new Error("Incorrect view code");
      }
      setViewCode("");
      setLocked(false);
      await load();
    } catch (unlockFailure) {
      setUnlockError(
        unlockFailure instanceof Error
          ? unlockFailure.message
          : "Unable to unlock right now",
      );
    } finally {
      setUnlocking(false);
    }
  }

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      try {
        const preferences = JSON.parse(
          window.localStorage.getItem(PREFERENCE_KEY) || "{}",
        ) as Partial<DashboardPreferences>;
        if (WARNING_LEVELS.includes(Number(preferences.warningThreshold))) {
          setWarningThreshold(Number(preferences.warningThreshold));
        }
        if (Array.isArray(preferences.hiddenProviders)) {
          setHiddenProviders(
            preferences.hiddenProviders.filter(
              (value): value is string => typeof value === "string",
            ),
          );
        }
      } catch {
        // Invalid local preferences should not block live usage data.
      }
      void load();
    }, 0);
    const refreshTimer = window.setInterval(() => void load(), REFRESH_SECONDS * 1000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
    };
  }, [load]);

  useEffect(() => {
    // A wall display or restored tab should show fresh data promptly.
    const handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastLoadedAtRef.current > 30_000
      ) {
        void load();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [load]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isTyping || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "r") {
        void load(true);
      }
      if (event.key.toLowerCase() === "d") {
        window.location.href = displayMode ? "/" : "/display";
      }
      if (event.key === ",") {
        setControlsOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [displayMode, load]);

  const visibleProviders = useMemo(
    () =>
      (data?.providers || []).filter(
        (provider) => !hiddenProviders.includes(provider.id),
      ),
    [data, hiddenProviders],
  );

  const riskProviders = useMemo(
    () =>
      visibleProviders.filter(
        (provider) => providerRisk(provider, warningThreshold) !== "normal",
      ),
    [visibleProviders, warningThreshold],
  );
  const staleProviders = useMemo(
    () => visibleProviders.filter(isProviderStale),
    [visibleProviders],
  );

  const nextReset = useMemo(() => {
    const generatedAt = new Date(data?.generatedAt || 0).getTime();
    const resets =
      visibleProviders.flatMap((provider) =>
        provider.windows.map((window) => ({
          ...resolveReset(provider.id, window, history),
          window,
        })),
      ) || [];
    return pickNextReset(resets, generatedAt);
  }, [data?.generatedAt, history, visibleProviders]);

  function savePreferences(next: DashboardPreferences) {
    window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(next));
  }

  function chooseWarningThreshold(value: number) {
    setWarningThreshold(value);
    savePreferences({ warningThreshold: value, hiddenProviders });
  }

  function toggleProvider(providerId: string) {
    const next = hiddenProviders.includes(providerId)
      ? hiddenProviders.filter((id) => id !== providerId)
      : [...hiddenProviders, providerId];
    setHiddenProviders(next);
    savePreferences({ warningThreshold, hiddenProviders: next });
  }

  async function copySummary() {
    if (!data) return;
    const lines = [
      `AI Usage Dashboard · ${formatUpdated(data.generatedAt)}`,
      ...visibleProviders.map((provider) => {
        const primary = getPrimaryWindow(provider);
        const reset = resolveReset(provider.id, primary, history);
        const usage = primary
          ? `${primary.label} ${formatPercent(primary.usedPercent)}`
          : provider.balance
            ? `${provider.balance.label} ${formatBalance(
                provider.balance.value,
                provider.balance.unit,
              )}`
            : providerStateLabel(provider);
        return `${provider.name}: ${usage}${
          reset.resetsAt ? ` · resets ${formatCountdown(reset.resetsAt)}` : ""
        }`;
      }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  }

  return (
    <main className={displayMode ? "dashboard dashboard--display" : "dashboard"}>
      <a className="skip-link" href="#dashboard-content">
        Skip to main content
      </a>
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />

      <div className="dashboard__shell">
        {locked ? (
          <section className="access-gate" aria-labelledby="access-title">
            <span className="access-gate__mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="eyebrow">LOCAL-FIRST · PRIVATE DISPLAY</span>
            <h1 id="access-title">AI Usage Dashboard</h1>
            <p>Enter the view code once; this device stays signed in for 30 days.</p>
            <form onSubmit={unlock}>
              <label htmlFor="view-code">View code</label>
              <input
                id="view-code"
                type="password"
                autoComplete="current-password"
                value={viewCode}
                onChange={(event) => setViewCode(event.target.value)}
                placeholder="Enter the view code generated on your machine"
                required
              />
              <button type="submit" disabled={unlocking}>
                {unlocking ? "Verifying…" : "Open dashboard"}
              </button>
            </form>
            {unlockError ? (
              <div className="access-gate__error" role="alert">
                {unlockError}
              </div>
            ) : null}
            <small>
              This page only receives sanitized quota snapshots. No AI provider
              credentials are stored.
            </small>
          </section>
        ) : null}

        <div
          className={
            locked
              ? "dashboard__content dashboard__content--locked"
              : "dashboard__content"
          }
          id="dashboard-content"
          inert={locked ? true : undefined}
        >
        {displayMode ? (
          <DedicatedDisplay
            data={data}
            providers={visibleProviders}
            history={history}
            error={error}
            refreshSignal={refreshSignal}
            warningThreshold={warningThreshold}
            onRefresh={() => void load(true)}
          />
        ) : (
        <>
        <header className="topbar">
          <div className="brand">
            <span className="brand__signal" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div>
              <span className="eyebrow">LOCAL-FIRST · MULTI-PROVIDER</span>
              <h1>AI Usage Dashboard</h1>
            </div>
          </div>

          <div className="topbar__actions">
            <Link
              className="utility-button display-launch"
              href="/display"
              title="Open the standalone view for an external always-on screen"
            >
              <span aria-hidden="true">▣</span>
              Display
            </Link>
            <button
              className="utility-button"
              type="button"
              onClick={() => void copySummary()}
              disabled={!data}
              title="Copy a sanitized usage summary"
              aria-live="polite"
            >
              <span aria-hidden="true">⌘</span>
              {copyState === "copied"
                ? "Copied"
                : copyState === "error"
                  ? "Copy failed"
                  : "Summary"}
            </button>
            <button
              className={`utility-button ${controlsOpen ? "is-active" : ""}`}
              type="button"
              onClick={() => setControlsOpen((value) => !value)}
              aria-expanded={controlsOpen}
              aria-controls="dashboard-controls"
            >
              <span aria-hidden="true">☷</span>
              Manage
            </button>
            <button
              className="refresh-button"
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing}
            >
              <span aria-hidden="true">{refreshing ? "···" : "↻"}</span>
              {refreshing ? (
                "Refreshing"
              ) : (
                <RefreshCountdown
                  key={refreshSignal}
                  seconds={REFRESH_SECONDS}
                />
              )}
            </button>
          </div>
        </header>

        {controlsOpen ? (
          <section
            className="control-dock"
            id="dashboard-controls"
            aria-label="Dashboard display settings"
          >
            <div className="control-dock__group">
              <span className="eyebrow">Providers</span>
              <div className="provider-toggles">
                {(data?.providers || []).map((provider) => {
                  const visible = !hiddenProviders.includes(provider.id);
                  return (
                    <button
                      key={provider.id}
                      className={visible ? "is-active" : ""}
                      type="button"
                      onClick={() => toggleProvider(provider.id)}
                      aria-pressed={visible}
                    >
                      <i style={{ background: provider.accent }} />
                      {provider.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="control-dock__group control-dock__threshold">
              <span className="eyebrow">Warning threshold</span>
              <div>
                {WARNING_LEVELS.map((value) => (
                  <button
                    key={value}
                    className={warningThreshold === value ? "is-active" : ""}
                    type="button"
                    onClick={() => chooseWarningThreshold(value)}
                  >
                    {value}%
                  </button>
                ))}
              </div>
              <small>
                {riskProviders.length
                  ? `${riskProviders.length} provider${
                      riskProviders.length > 1 ? "s" : ""
                    } at the warning threshold`
                  : "No providers at the warning threshold"}
              </small>
            </div>
            <div className="control-dock__shortcuts">
              <span className="eyebrow">Shortcuts</span>
              <p>
                <kbd>R</kbd> refresh <kbd>D</kbd> display view{" "}
                <kbd>,</kbd> manage
              </p>
              <small>Display preferences are stored only in this browser.</small>
            </div>
          </section>
        ) : null}

        <section className="overview-strip" aria-label="Collector status">
          <div>
            <span className="overview-strip__dot" />
            <p>
              <b>
                {data?.collector.state === "online"
                  ? staleProviders.length
                    ? `${visibleProviders.length - staleProviders.length} live · ${staleProviders.length} stale`
                    : riskProviders.length
                      ? `${riskProviders.length} provider${
                          riskProviders.length > 1 ? "s" : ""
                        } need attention`
                      : "Collecting live"
                  : "Waiting for collector"}
              </b>
              <span>
                {visibleProviders.map((provider) => provider.name).join(" · ") ||
                  "Waiting for data"}
              </span>
            </p>
          </div>
          <div className="overview-strip__reset">
            <span className="eyebrow">Last data</span>
            <strong>{formatUpdated(data?.generatedAt || null)}</strong>
          </div>
          <div className="overview-strip__reset">
            <span className="eyebrow">Next reset</span>
            <strong>
              {nextReset?.estimated ? "est. " : ""}
              {nextReset ? formatCountdown(nextReset.resetsAt) : "waiting for data"}
            </strong>
          </div>
          <div className="privacy-lock">
            <span aria-hidden="true">●</span>
            Credentials never leave this machine
          </div>
        </section>

        <TokenOverview providers={visibleProviders} />

        {error ? (
          <div className="connection-alert" role="alert">
            <span aria-hidden="true">!</span>
            <div>
              <strong>Collector not connected</strong>
              <p>{error}</p>
            </div>
            <button type="button" onClick={() => void load(true)}>
              Retry
            </button>
          </div>
        ) : null}

        <section className="provider-grid" aria-label="AI provider usage">
          {visibleProviders.length ? (
            visibleProviders.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                history={history}
                warningThreshold={warningThreshold}
              />
            ))
          ) : data?.providers.length ? (
            <div className="provider-empty-state">
              <span aria-hidden="true">◌</span>
              <strong>All providers are hidden</strong>
              <p>Re-enable at least one provider under Manage.</p>
              <button type="button" onClick={() => setControlsOpen(true)}>
                Open Manage
              </button>
            </div>
          ) : error ? (
            <div className="provider-empty-state provider-empty-state--error">
              <span aria-hidden="true">!</span>
              <strong>Cannot read provider usage right now</strong>
              <p>
                The page retries automatically once the collector recovers, or
                you can refresh manually.
              </p>
              <button type="button" onClick={() => void load(true)}>
                Retry now
              </button>
            </div>
          ) : (
            <>
              <LoadingCard
                id="codex"
                name="OpenAI Codex"
                shortName="CX"
                accent="#7bf1a8"
              />
              <LoadingCard
                id="kimi"
                name="Kimi Code"
                shortName="KM"
                accent="#89a8ff"
              />
            </>
          )}
        </section>

        {historyTruncated ? (
          <p className="history-truncated" role="note">
            History truncated; showing only the most recent data
          </p>
        ) : null}

        <footer className="dashboard-footer">
          <p>
            <span />
            Usage layers are never summed · missing observations labeled as such
          </p>
          <p>
            Collector {data?.collector.version || DASHBOARD_VERSION} ·
            auto-refresh every 60s
          </p>
        </footer>
        </>
        )}
        </div>
      </div>
    </main>
  );
}
