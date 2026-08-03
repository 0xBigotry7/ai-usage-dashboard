import { memo } from "react";
import {
  clamp,
  formatAge,
  formatBalance,
  formatCountdown,
  formatPercent,
  formatResetClock,
  formatUpdated,
} from "../../lib/format";
import {
  getPeakWindow,
  getPreferredTokenUsage,
  getPrimaryWindow,
  getTokenEstimates,
  isProviderStale,
  lookupReset,
  normalizeBars,
  providerRisk,
  providerStateLabel,
  type ResetLookup,
} from "../../lib/provider-selectors";
import type { HistoryPoint, Provider } from "../../lib/usage-types";
import { ProviderLogo } from "../provider-logo";
import { ProviderTokenPanel } from "./ProviderTokenPanel";
import { WindowRow } from "./WindowRow";

export const ProviderCard = memo(function ProviderCard({
  provider,
  history,
  resets,
  warningThreshold,
}: {
  provider: Provider;
  history: HistoryPoint[];
  resets: ResetLookup;
  warningThreshold: number;
}) {
  const primary = getPrimaryWindow(provider);
  const fiveHour = provider.windows.find((window) => window.id === "five_hour");
  const primaryReset = lookupReset(resets, provider.id, primary);
  const fiveHourReset = lookupReset(resets, provider.id, fiveHour);
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
                  reset={lookupReset(resets, provider.id, window)}
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
