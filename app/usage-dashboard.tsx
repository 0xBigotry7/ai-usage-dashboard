"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { estimateNextResetAt } from "../lib/reset-estimate";

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
  countedInTotal: boolean;
};

type TokenUsage = {
  basis: "quota_percentage" | "session_logs";
  estimated: true;
  totalTokens: number;
  capacityTokens?: number;
  usedPercent?: number;
  windowId?: string;
  periodSeconds?: number;
  sessionCount?: number;
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
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function providerStateLabel(provider: Provider) {
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

function getTokenEstimates(provider: Provider) {
  if (provider.tokenEstimates?.length) return provider.tokenEstimates;
  return provider.tokenUsage ? [provider.tokenUsage] : [];
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
  if (compacted.length > 1) {
    return compacted.slice(-22).map((point) => point.usedPercent || 0);
  }
  const current = getPrimaryWindow(provider)?.usedPercent ?? 0;
  return Array.from({ length: 16 }, (_, index) =>
    clamp(current - (15 - index) * Math.min(current / 35, 0.75)),
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
        <span className="eyebrow">Token 用量 · 双口径</span>
        <small>两种算法独立展示，不相加</small>
      </div>
      <div className="token-methods">
        {estimates.map((usage) => (
          <article className="token-method" key={usage.basis}>
            <header>
              <div>
                <span>
                  {usage.basis === "quota_percentage"
                    ? "配额百分比换算"
                    : "本机 CLI 日志"}
                </span>
                <strong title={exactTokens(usage.totalTokens)}>
                  {formatTokens(usage.totalTokens)}
                </strong>
              </div>
              <small>
                {usage.basis === "quota_percentage"
                  ? `${formatPercent(usage.usedPercent ?? null)} × ${formatTokens(
                      usage.capacityTokens ?? null,
                    )}`
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
    }))
    .filter(({ quota, logs }) => quota || logs);
  const quotaTotal = providerEstimates.reduce(
    (sum, { quota }) => sum + (quota?.totalTokens || 0),
    0,
  );
  const logTotal = providerEstimates.reduce(
    (sum, { logs }) => sum + (logs?.totalTokens || 0),
    0,
  );
  const hasLogs = providerEstimates.some(({ logs }) => logs);
  return (
    <section className="token-overview" aria-label="周 Token 双口径估算总览">
      <div className="token-overview__total">
        <span className="eyebrow">本周 Token · 双口径</span>
        <div>
          <strong title={exactTokens(quotaTotal)}>
            {formatTokens(quotaTotal)}
          </strong>
          <small>配额换算</small>
        </div>
        {hasLogs ? (
          <p className="token-overview__log">
            本机日志 <b title={exactTokens(logTotal)}>{formatTokens(logTotal)}</b>
          </p>
        ) : null}
      </div>
      <div className="token-overview__providers">
        {providerEstimates.length ? (
          providerEstimates.map(({ provider, quota, logs }) => (
            <div
              key={provider.id}
              style={{ "--provider-accent": provider.accent } as React.CSSProperties}
            >
              <span>{provider.name}</span>
              <strong title={quota ? exactTokens(quota.totalTokens) : undefined}>
                {quota ? formatTokens(quota.totalTokens) : "—"}
              </strong>
              <small>
                {logs
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
        配额换算覆盖账户整体但依赖容量假设；CLI 日志只统计本机可见记录。
        两者互为参考，不应相加。
      </p>
    </section>
  );
}

function ProviderCard({
  provider,
  history,
}: {
  provider: Provider;
  history: HistoryPoint[];
}) {
  const primary = getPrimaryWindow(provider);
  const fiveHour = provider.windows.find((window) => window.id === "five_hour");
  const primaryReset = resolveReset(provider.id, primary, history);
  const fiveHourReset = resolveReset(provider.id, fiveHour, history);
  const keyReset = fiveHour ? fiveHourReset : primaryReset;
  const bars = normalizeBars(history, provider);
  const isReady = provider.state === "ready";

  return (
    <article
      className={`provider-card provider-card--${provider.id}`}
      style={{ "--provider-accent": provider.accent } as React.CSSProperties}
    >
      <header className="provider-card__header">
        <div className="provider-identity">
          <span className="provider-mark" aria-hidden="true">
            {provider.shortName}
          </span>
          <div>
            <h2>{provider.name}</h2>
            <p>{provider.plan || "订阅状态未知"}</p>
          </div>
        </div>
        <span className={`state-pill state-pill--${provider.state}`}>
          <i />
          {providerStateLabel(provider)}
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
            <small>本周已使用</small>
          </div>
        </div>
        <div className="provider-card__signal">
          <span className="eyebrow">下一次关键重置</span>
          <strong>
            {keyReset.estimated && keyReset.resetsAt ? "预计 " : ""}
            {formatCountdown(keyReset.resetsAt)}
          </strong>
          <p>
            {fiveHour
              ? `5 小时窗口 · ${keyReset.estimated ? "约 " : ""}${formatResetClock(keyReset.resetsAt)}`
              : "当前账户没有返回 5 小时窗口"}
          </p>
          {provider.balance ? (
            <div className="balance-chip">
              <span>{provider.balance.label}</span>
              <b>{formatNumber(provider.balance.value)}</b>
            </div>
          ) : null}
        </div>
      </div>

      <div className="compact-windows" aria-label={`${provider.name}配额摘要`}>
        {provider.windows.map((window) => {
          const reset = resolveReset(provider.id, window, history);
          return (
            <div key={window.id}>
              <span>{window.label}</span>
              <strong>{formatPercent(window.usedPercent)}</strong>
              <small>
                {reset.estimated ? "预计 " : ""}
                {formatCountdown(reset.resetsAt)}
              </small>
            </div>
          );
        })}
        {!fiveHour ? (
          <div className="compact-windows__missing">
            <span>5 小时</span>
            <strong>—</strong>
            <small>平台未提供</small>
          </div>
        ) : null}
      </div>

      {isReady ? (
        <>
          {provider.message ? (
            <div className="provider-notice">
              <span aria-hidden="true">i</span>
              <p>{provider.message}</p>
            </div>
          ) : null}
          <div className="window-list">
            {provider.windows.map((window) => (
              <WindowRow
                key={window.id}
                window={window}
                reset={resolveReset(provider.id, window, history)}
              />
            ))}
            {!fiveHour ? (
              <div className="missing-window">
                <span>5 小时</span>
                <p>平台未提供此窗口，不做本地估算</p>
              </div>
            ) : null}
          </div>
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
          <div className="micro-bars" aria-label="过去 24 小时用量趋势">
            {bars.map((value, index) => (
              <i
                key={`${index}-${value}`}
                style={{ height: `${Math.max(8, value)}%` }}
              />
            ))}
          </div>
        </div>
        <div className="source-meta">
          <span>{provider.source}</span>
          <small>{formatUpdated(provider.updatedAt)}</small>
        </div>
      </footer>
    </article>
  );
}

function LoadingCard({ name, shortName }: { name: string; shortName: string }) {
  return (
    <article className="provider-card provider-card--loading" aria-busy="true">
      <header className="provider-card__header">
        <div className="provider-identity">
          <span className="provider-mark">{shortName}</span>
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

export function UsageDashboard() {
  const [data, setData] = useState<UsagePayload | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_SECONDS);
  const [compact, setCompact] = useState(false);
  const [locked, setLocked] = useState(false);
  const [viewCode, setViewCode] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

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
    const smallViewport = window.matchMedia("(max-width: 520px)");
    const enterCompactMode = (event: MediaQueryListEvent) => {
      if (event.matches) setCompact(true);
    };
    smallViewport.addEventListener("change", enterCompactMode);
    const initialTimer = window.setTimeout(() => {
      if (smallViewport.matches) setCompact(true);
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
      smallViewport.removeEventListener("change", enterCompactMode);
    };
  }, [load]);

  const nextReset = useMemo(() => {
    const generatedAt = new Date(data?.generatedAt || 0).getTime();
    const resets =
      data?.providers.flatMap((provider) =>
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
  }, [data, history]);

  function toggleCompact(value: boolean) {
    setCompact(value);
  }

  return (
    <main className={compact ? "dashboard dashboard--compact" : "dashboard"}>
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
            {unlockError ? <div className="access-gate__error">{unlockError}</div> : null}
            <small>页面只接收脱敏配额快照，不保存任何 AI 平台凭证。</small>
          </section>
        ) : null}

        <div className={locked ? "dashboard__content dashboard__content--locked" : "dashboard__content"}>
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
            <div className="view-switch" aria-label="界面密度">
              <button
                className={!compact ? "is-active" : ""}
                onClick={() => toggleCompact(false)}
                type="button"
              >
                仪表
              </button>
              <button
                className={compact ? "is-active" : ""}
                onClick={() => toggleCompact(true)}
                type="button"
              >
                小屏
              </button>
            </div>
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

        <section className="overview-strip" aria-label="采集状态">
          <div>
            <span className="overview-strip__dot" />
            <p>
              <b>{data?.collector.state === "online" ? "实时采集中" : "等待采集器"}</b>
              <span>
                {data?.providers.map((provider) => provider.name).join(" · ") ||
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

        <TokenOverview providers={data?.providers || []} />

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
          {data?.providers.length ? (
            data.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                history={history}
              />
            ))
          ) : (
            <>
              <LoadingCard name="OpenAI Codex" shortName="CX" />
              <LoadingCard name="Kimi Code" shortName="KM" />
            </>
          )}
        </section>

        <footer className="dashboard-footer">
          <p>
            <span />
            配额来自平台接口 · Token 支持配额换算与本机日志两种估算
          </p>
          <p>
            Collector {data?.collector.version || "0.1.0"} · 自动刷新 60 秒
          </p>
        </footer>
        </div>
      </div>
    </main>
  );
}
