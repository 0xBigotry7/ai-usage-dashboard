"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { estimateNextResetAt } from "../lib/reset-estimate";
import { ProviderLogo } from "./provider-logo";

type WindowUsage = {
  id: string;
  label: string;
  durationSeconds: number;
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
  requestCount?: number;
  countedInTotal: boolean;
};

type TokenUsage = {
  basis: "quota_percentage" | "session_logs" | "api_usage";
  estimated: boolean;
  totalTokens: number;
  capacityTokens?: number;
  usedPercent?: number;
  windowId?: string;
  periodSeconds?: number;
  sessionCount?: number;
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
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: value % 1 ? 1 : 0,
  }).format(value);
}

function formatTokens(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(value);
}

function exactTokens(value: number) {
  return `${new Intl.NumberFormat("zh-CN").format(value)} tokens`;
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
  if (!resetsAt) return "未提供重置时间";
  const difference = new Date(resetsAt).getTime() - Date.now();
  if (difference <= 0) return "等待刷新";
  const minutes = Math.max(1, Math.floor(difference / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const restMinutes = minutes % 60;
  if (days > 0) return `${days}天 ${hours}小时后`;
  if (hours > 0) return `${hours}小时 ${restMinutes}分钟后`;
  return `${restMinutes}分钟后`;
}

function formatResetClock(resetsAt: string | null) {
  if (!resetsAt) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(resetsAt));
}

function formatUpdated(value: string | null) {
  if (!value) return "尚未连接";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatAge(value: string | null) {
  if (!value) return "时间未知";
  const ageMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "刚刚";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
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
  if (isProviderStale(provider)) return "数据已过期";
  switch (provider.state) {
    case "ready":
      return "数据正常";
    case "needs_configuration":
      return "等待配置";
    case "auth_error":
      return "需要登录";
    default:
      return "连接异常";
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
  if (basis === "quota_percentage") return "配额百分比换算";
  if (basis === "api_usage") return "官方 API 统计";
  return "本机 CLI 日志";
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
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const weekly = points.filter(
    (point) =>
      point.providerId === provider.id &&
      point.windowId === "weekly" &&
      point.usedPercent !== null &&
      new Date(point.capturedAt).getTime() >= dayAgo,
  );
  const compacted = weekly.length > 22
    ? weekly.filter((_, index) => index % Math.ceil(weekly.length / 22) === 0)
    : weekly;
  return compacted.length > 1
    ? compacted.slice(-22).map((point) => point.usedPercent || 0)
    : [];
}

function getPreferredTokenUsage(provider: Provider) {
  const estimates = getTokenEstimates(provider);
  return (
    estimates.find((estimate) => estimate.basis === "api_usage") ||
    estimates.find((estimate) => estimate.basis === "session_logs") ||
    estimates.find((estimate) => estimate.basis === "quota_percentage") ||
    null
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
            {reset.estimated && reset.resetsAt ? "预计 " : ""}
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
        aria-label={`${window.label}已使用`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent ?? undefined}
      >
        <span style={{ width: `${clamp(percent)}%` }} />
      </div>
      <div className="window-row__detail">
        <span>
          {reset.estimated && reset.resetsAt ? "约 " : ""}
          {formatResetClock(reset.resetsAt)} 重置
          {reset.estimated && reset.resetsAt ? " · 历史周期推算" : ""}
        </span>
        {window.limit !== null ? (
          <span>
            {formatNumber(window.used)} / {formatNumber(window.limit)}
          </span>
        ) : (
          <span>平台真实配额</span>
        )}
      </div>
    </div>
  );
}

function ProviderTokenPanel({ estimates }: { estimates: TokenUsage[] }) {
  return (
    <section className="token-panel" aria-label="Token 用量估算">
      <div className="token-panel__heading">
        <span className="eyebrow">Token 用量 · 多口径</span>
        <small>官方统计与两种估算独立展示</small>
      </div>
      <div className="token-methods">
        {estimates.map((usage) => (
          <article className="token-method" key={usage.basis}>
            <header>
              <div>
                <span>{tokenBasisLabel(usage.basis)}</span>
                <strong title={exactTokens(usage.totalTokens)}>
                  {formatTokens(usage.totalTokens)}
                </strong>
              </div>
              <small>
                {usage.basis === "quota_percentage"
                  ? `${formatPercent(usage.usedPercent ?? null)} × ${formatTokens(
                      usage.capacityTokens ?? null,
                    )}`
                  : usage.basis === "api_usage"
                    ? `过去 7 天 · ${formatNumber(
                        usage.requestCount ?? 0,
                      )} 次请求`
                    : `过去 7 天 · ${formatNumber(
                        usage.sessionCount ?? 0,
                      )} 个会话`}
              </small>
            </header>
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
                          )} 周容量`
                        : usage.basis === "api_usage"
                          ? `${formatNumber(
                              model.requestCount ?? 0,
                            )} 次官方请求`
                          : "token_count 增量"}
                      {model.countedInTotal ? "" : " · 独立额度，不计入总数"}
                    </small>
                  </div>
                  <strong title={exactTokens(model.estimatedTokens)}>
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

function TokenOverview({ providers }: { providers: Provider[] }) {
  const providerEstimates = providers
    .map((provider) => ({
      provider,
      quota: getTokenEstimates(provider).find(
        (estimate) => estimate.basis === "quota_percentage",
      ),
      logs: getTokenEstimates(provider).find(
        (estimate) => estimate.basis === "session_logs",
      ),
      official: getTokenEstimates(provider).find(
        (estimate) => estimate.basis === "api_usage",
      ),
    }))
    .filter(({ quota, logs, official }) => quota || logs || official);
  const quotaTotal = providerEstimates.reduce(
    (sum, { quota }) => sum + (quota?.totalTokens || 0),
    0,
  );
  const logTotal = providerEstimates.reduce(
    (sum, { logs }) => sum + (logs?.totalTokens || 0),
    0,
  );
  const officialTotal = providerEstimates.reduce(
    (sum, { official }) => sum + (official?.totalTokens || 0),
    0,
  );
  const hasLogs = providerEstimates.some(({ logs }) => logs);
  const hasOfficial = providerEstimates.some(({ official }) => official);
  const hasQuota = providerEstimates.some(({ quota }) => quota);
  return (
    <section className="token-overview" aria-label="周 Token 多口径总览">
      <div className="token-overview__total">
        <span className="eyebrow">本周 Token · 多口径</span>
        <div>
          <strong title={hasQuota ? exactTokens(quotaTotal) : undefined}>
            {hasQuota ? formatTokens(quotaTotal) : "未提供"}
          </strong>
          <small>配额换算</small>
        </div>
        {hasLogs ? (
          <p className="token-overview__log">
            本机日志 <b title={exactTokens(logTotal)}>{formatTokens(logTotal)}</b>
          </p>
        ) : null}
        {hasOfficial ? (
          <p className="token-overview__official">
            官方 API{" "}
            <b title={exactTokens(officialTotal)}>
              {formatTokens(officialTotal)}
            </b>
          </p>
        ) : null}
      </div>
      <div className="token-overview__providers">
        {providerEstimates.length ? (
          providerEstimates.map(({ provider, quota, logs, official }) => (
            <div
              key={provider.id}
              style={{ "--provider-accent": provider.accent } as React.CSSProperties}
            >
              <span>{provider.name}</span>
              <strong title={quota ? exactTokens(quota.totalTokens) : undefined}>
                {quota
                  ? formatTokens(quota.totalTokens)
                  : official
                    ? formatTokens(official.totalTokens)
                    : "—"}
              </strong>
              <small>
                {official
                  ? `官方 API ${formatTokens(official.totalTokens)}`
                  : logs
                  ? `本机日志 ${formatTokens(logs.totalTokens)}`
                  : "暂无本机日志估算"}
              </small>
            </div>
          ))
        ) : (
          <p>等待平台配额或本机会话日志</p>
        )}
      </div>
      <p className="token-overview__note">
        官方 API、配额换算与 CLI 日志覆盖范围不同。它们独立展示，不相加。
      </p>
    </section>
  );
}

function ProviderCard({
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
            <p>{provider.plan || "订阅状态未知"}</p>
          </div>
        </div>
        <span
          className={`state-pill state-pill--${provider.state} state-pill--risk-${risk} ${stale ? "state-pill--stale" : ""}`}
        >
          <i />
          {stale
            ? `过期 · ${formatAge(provider.updatedAt)}`
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
            <small>{hasQuota ? `${primary?.label || "当前"}已使用` : "无配额窗口"}</small>
          </div>
        </div>
        <div className="provider-card__signal">
          <span className="eyebrow">下一次关键重置</span>
          <strong>
            {keyReset.resetsAt ? (
              <>
                {keyReset.estimated ? "预计 " : ""}
                {formatCountdown(keyReset.resetsAt)}
              </>
            ) : (
              "没有重置窗口"
            )}
          </strong>
          <p>
            {fiveHour
              ? `5 小时窗口 · ${keyReset.estimated ? "约 " : ""}${formatResetClock(keyReset.resetsAt)}`
              : primary
                ? `${primary.label}窗口 · ${keyReset.estimated ? "约 " : ""}${formatResetClock(keyReset.resetsAt)}`
                : "当前接口提供余额或模型用量，不提供配额窗口"}
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
              <p>这是余额或模型统计接口，没有可换算的订阅配额窗口。</p>
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
        <ProviderTokenPanel estimates={getTokenEstimates(provider)} />
      ) : null}

      <footer className="provider-card__footer">
        <div>
          <span className="eyebrow">过去 24 小时</span>
          {bars.length > 1 ? (
            <div className="micro-bars" aria-label="过去 24 小时真实用量趋势">
              {bars.map((value, index) => (
                <i
                  key={`${index}-${value}`}
                  style={{ height: `${Math.max(8, value)}%` }}
                />
              ))}
            </div>
          ) : (
            <p className="history-pending">历史积累中</p>
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
}

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
                  aria-label={`${provider.name} ${window.label}已用`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={window.usedPercent ?? undefined}
                >
                  <i style={{ width: `${clamp(window.usedPercent ?? 0)}%` }} />
                </div>
                <small>
                  {reset.estimated ? "预计 " : ""}
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
          <span>{provider.message || "当前接口没有返回可显示指标"}</span>
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
                  {formatTokens(model.estimatedTokens)}
                </strong>
              </div>
            ))}
          </div>
        ) : (
          <span className="display-models__empty">暂无逐模型统计</span>
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
};

function DedicatedDisplay({
  data,
  providers,
  history,
  error,
  secondsLeft,
  warningThreshold,
  onRefresh,
}: {
  data: UsagePayload | null;
  providers: Provider[];
  history: HistoryPoint[];
  error: string | null;
  secondsLeft: number;
  warningThreshold: number;
  onRefresh: () => void;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(3);
  const [wakeLock, setWakeLock] = useState<WakeLockSentinelLike | null>(null);
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
        new Intl.DateTimeFormat("zh-CN", {
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

  useEffect(
    () => () => {
      if (wakeLock && !wakeLock.released) void wakeLock.release();
    },
    [wakeLock],
  );

  async function toggleWakeLock() {
    if (wakeLock && !wakeLock.released) {
      await wakeLock.release();
      setWakeLock(null);
      return;
    }
    const navigatorWithWakeLock = navigator as Navigator & {
      wakeLock?: {
        request: (type: "screen") => Promise<WakeLockSentinelLike>;
      };
    };
    if (!navigatorWithWakeLock.wakeLock) return;
    try {
      setWakeLock(await navigatorWithWakeLock.wakeLock.request("screen"));
    } catch {
      setWakeLock(null);
    }
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  }

  const staleCount = providers.filter(isProviderStale).length;
  return (
    <section className="dedicated-display" aria-label="外接常亮小屏">
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
                ? "采集器离线"
                : staleCount
                  ? `${providers.length - staleCount} 实时 · ${staleCount} 陈旧`
                  : `${providers.length} 个平台实时`}
            </small>
          </span>
        </div>
        <div className="display-clock">
          <strong>{clock}</strong>
          <small>{secondsLeft}s 后刷新</small>
        </div>
        <nav className="display-actions" aria-label="小屏控制">
          <button
            type="button"
            className={wakeLock && !wakeLock.released ? "is-active" : ""}
            onClick={() => void toggleWakeLock()}
            title="防止屏幕自动休眠"
          >
            常亮
          </button>
          <button type="button" onClick={() => void toggleFullscreen()}>
            {fullscreen ? "退出全屏" : "全屏"}
          </button>
          <button type="button" onClick={onRefresh}>
            刷新
          </button>
          <Link href="/">仪表</Link>
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
            <strong>{error ? "采集器暂时不可用" : "等待第一份用量快照"}</strong>
            <span>{error || "数据到达后会自动显示，无需刷新页面。"}</span>
          </div>
        )}
      </div>

      <footer className="display-footer">
        <span>
          {data?.generatedAt
            ? `快照 ${formatAge(data.generatedAt)}`
            : "正在连接本机采集器"}
        </span>
        {pageCount > 1 ? (
          <div aria-label="平台分页">
            {Array.from({ length: pageCount }, (_, index) => (
              <button
                key={index}
                type="button"
                className={activePage === index ? "is-active" : ""}
                onClick={() => setPage(index)}
                aria-label={`显示第 ${index + 1} 页`}
                aria-pressed={activePage === index}
              />
            ))}
          </div>
        ) : null}
        <span>480×320 · 800×480 专用视图</span>
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
            <p>正在读取真实配额</p>
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
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_SECONDS);
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

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const apiBase = getApiBase();
      const isLocalCollector = apiBase.length > 0;
      const usageResponse = await (
        manual && isLocalCollector
          ? fetch(`${apiBase}/api/refresh`, { method: "POST" })
          : fetch(`${apiBase}/api/usage`, { cache: "no-store" })
      );
      if (usageResponse.status === 401 && !isLocalCollector) {
        setLocked(true);
        setData(null);
        setError(null);
        return;
      }
      const historyResponse = await fetch(`${apiBase}/api/history?hours=168`, {
        cache: "no-store",
      });
      if (!usageResponse.ok || !historyResponse.ok) {
        throw new Error("用量服务返回异常");
      }
      const [usagePayload, historyPayload] = await Promise.all([
        usageResponse.json() as Promise<UsagePayload>,
        historyResponse.json() as Promise<{ points?: HistoryPoint[] }>,
      ]);
      setData(usagePayload);
      setHistory(historyPayload.points || []);
      setLocked(false);
      setError(null);
      setSecondsLeft(REFRESH_SECONDS);
    } catch {
      setError("暂时无法连接用量采集服务，请稍后重试。");
    } finally {
      setRefreshing(false);
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
        throw new Error("访问码不正确");
      }
      setViewCode("");
      setLocked(false);
      await load();
    } catch (unlockFailure) {
      setUnlockError(
        unlockFailure instanceof Error ? unlockFailure.message : "暂时无法解锁",
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
    const countdownTimer = window.setInterval(
      () => setSecondsLeft((value) => (value <= 1 ? REFRESH_SECONDS : value - 1)),
      1000,
    );
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
      window.clearInterval(countdownTimer);
    };
  }, [load]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void load(true);
        return;
      }
      if (isTyping || event.metaKey || event.ctrlKey || event.altKey) return;
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
    return resets
      .filter(
        (reset) =>
          reset.resetsAt &&
          new Date(reset.resetsAt).getTime() > generatedAt,
      )
      .sort(
        (a, b) =>
          new Date(a.resetsAt || 0).getTime() -
          new Date(b.resetsAt || 0).getTime(),
      )[0];
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
          reset.resetsAt ? ` · ${formatCountdown(reset.resetsAt)}重置` : ""
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
        跳到主要内容
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
            <p>输入查看码后，这台设备会保持登录 30 天。</p>
            <form onSubmit={unlock}>
              <label htmlFor="view-code">查看码</label>
              <input
                id="view-code"
                type="password"
                autoComplete="current-password"
                value={viewCode}
                onChange={(event) => setViewCode(event.target.value)}
                placeholder="输入本机生成的查看码"
                required
              />
              <button type="submit" disabled={unlocking}>
                {unlocking ? "验证中…" : "打开仪表盘"}
              </button>
            </form>
            {unlockError ? (
              <div className="access-gate__error" role="alert">
                {unlockError}
              </div>
            ) : null}
            <small>页面只接收脱敏配额快照，不保存任何 AI 平台凭证。</small>
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
            secondsLeft={secondsLeft}
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
              title="打开适合外接常亮屏的独立视图"
            >
              <span aria-hidden="true">▣</span>
              外接屏
            </Link>
            <button
              className="utility-button"
              type="button"
              onClick={() => void copySummary()}
              disabled={!data}
              title="复制当前脱敏摘要"
              aria-live="polite"
            >
              <span aria-hidden="true">⌘</span>
              {copyState === "copied"
                ? "已复制"
                : copyState === "error"
                  ? "复制失败"
                  : "摘要"}
            </button>
            <button
              className={`utility-button ${controlsOpen ? "is-active" : ""}`}
              type="button"
              onClick={() => setControlsOpen((value) => !value)}
              aria-expanded={controlsOpen}
              aria-controls="dashboard-controls"
            >
              <span aria-hidden="true">☷</span>
              管理
            </button>
            <button
              className="refresh-button"
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing}
            >
              <span aria-hidden="true">{refreshing ? "···" : "↻"}</span>
              {refreshing ? "刷新中" : `${secondsLeft}s`}
            </button>
          </div>
        </header>

        {controlsOpen ? (
          <section
            className="control-dock"
            id="dashboard-controls"
            aria-label="Dashboard 显示设置"
          >
            <div className="control-dock__group">
              <span className="eyebrow">显示平台</span>
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
              <span className="eyebrow">关注阈值</span>
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
                  ? `${riskProviders.length} 个平台达到关注阈值`
                  : "当前没有平台达到关注阈值"}
              </small>
            </div>
            <div className="control-dock__shortcuts">
              <span className="eyebrow">快捷键</span>
              <p>
                <kbd>⌘ R</kbd> 刷新 <kbd>D</kbd> 打开外接屏{" "}
                <kbd>,</kbd> 打开管理
              </p>
              <small>显示偏好只保存在当前浏览器。</small>
            </div>
          </section>
        ) : null}

        <section className="overview-strip" aria-label="采集状态">
          <div>
            <span className="overview-strip__dot" />
            <p>
              <b>
                {data?.collector.state === "online"
                  ? staleProviders.length
                    ? `${visibleProviders.length - staleProviders.length} 实时 · ${staleProviders.length} 陈旧`
                    : riskProviders.length
                      ? `${riskProviders.length} 个平台需关注`
                      : "实时采集中"
                  : "等待采集器"}
              </b>
              <span>
                {visibleProviders.map((provider) => provider.name).join(" · ") ||
                  "等待数据"}
              </span>
            </p>
          </div>
          <div className="overview-strip__reset">
            <span className="eyebrow">最近一次数据</span>
            <strong>{formatUpdated(data?.generatedAt || null)}</strong>
          </div>
          <div className="overview-strip__reset">
            <span className="eyebrow">下一个重置</span>
            <strong>
              {nextReset?.estimated ? "预计 " : ""}
              {nextReset ? formatCountdown(nextReset.resetsAt) : "等待数据"}
            </strong>
          </div>
          <div className="privacy-lock">
            <span aria-hidden="true">●</span>
            凭证不进入云端
          </div>
        </section>

        <TokenOverview providers={visibleProviders} />

        {error ? (
          <div className="connection-alert" role="alert">
            <span aria-hidden="true">!</span>
            <div>
              <strong>采集器未连接</strong>
              <p>{error}</p>
            </div>
            <button type="button" onClick={() => void load(true)}>
              重试
            </button>
          </div>
        ) : null}

        <section className="provider-grid" aria-label="AI 平台用量">
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
              <strong>所有平台都已隐藏</strong>
              <p>在“管理”里重新打开至少一个平台。</p>
              <button type="button" onClick={() => setControlsOpen(true)}>
                打开管理
              </button>
            </div>
          ) : error ? (
            <div className="provider-empty-state provider-empty-state--error">
              <span aria-hidden="true">!</span>
              <strong>暂时无法读取平台用量</strong>
              <p>采集器恢复后页面会自动重试，也可以立即手动刷新。</p>
              <button type="button" onClick={() => void load(true)}>
                立即重试
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

        <footer className="dashboard-footer">
          <p>
            <span />
            官方 API、配额换算与本机日志分开呈现 · 不重复相加
          </p>
          <p>
            Collector {data?.collector.version || "0.8.0"} · 自动刷新 60 秒
          </p>
        </footer>
        </>
        )}
        </div>
      </div>
    </main>
  );
}
