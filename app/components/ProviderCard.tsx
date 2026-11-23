import { memo } from "react";
import {
  clamp,
  formatAge,
  formatBalance,
  formatCountdown,
  formatPercent,
  formatQuotaReset,
  formatResetDate,
  formatTokens,
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
import { ProviderLogo, brandAccent } from "../provider-logo";
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
  const resetWindow = fiveHour ?? primary;
  const keyReset = lookupReset(resets, provider.id, resetWindow);
  const bars = normalizeBars(history, provider);
  const isReady = provider.state === "ready";
  const risk = providerRisk(provider, warningThreshold);
  const peakWindow = getPeakWindow(provider);
  const stale = isProviderStale(provider);
  const isManual = provider.sourceKind === "manual";
  const isAntigravity = provider.id === "antigravity";
  const billingPeriod = provider.id === "cursor"
    ? provider.usageDetails?.find((detail) => detail.label === "Billing period ends")
    : null;
  const usageDetails = provider.usageDetails?.filter((detail) => detail !== billingPeriod);
  const usedPercent = primary?.usedPercent ?? null;
  const remainingPercent = usedPercent === null ? null : clamp(100 - usedPercent);
  const resetDate = resetWindow?.resetDate;
  const isSingleWindow = provider.windows.length === 1 && usedPercent !== null;
  const tokenEstimates = getTokenEstimates(provider);

  return (
    <article
      className={`provider-card provider-card--${provider.id} provider-card--risk-${risk} ${stale ? "provider-card--stale" : ""}`}
      data-provider={provider.id}
      style={{ "--provider-accent": brandAccent(provider) } as React.CSSProperties}
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
              ? `${peakWindow.label} · low quota`
              : providerStateLabel(provider)}
        </span>
      </header>

      {usedPercent !== null ? (
        <div className="provider-card__hero">
          <div className="usage-ring" aria-hidden="true" style={{
            "--ring-value": `${(remainingPercent ?? 0) * 3.6}deg`,
          } as React.CSSProperties} />
          <div className="quota-facts">
            <span className="quota-facts__window">{primary?.label}</span>
            <dl className="quota-facts__figures">
              <div><dt>Remaining</dt><dd>{formatPercent(remainingPercent)}</dd></div>
            </dl>
          </div>
          <div className="quota-reset">
            <span>{billingPeriod?.label ?? (fiveHour && fiveHour !== primary ? "5-hour reset" : "Resets")}</span>
            <div>
              {billingPeriod ? <strong>{billingPeriod.value}</strong> : resetDate ? (
                <time dateTime={resetDate}>{formatResetDate(resetDate)}</time>
              ) : keyReset.resetsAt ? (
                <>
                  <time dateTime={keyReset.resetsAt}>{keyReset.estimated ? "≈ " : ""}{formatQuotaReset(keyReset.resetsAt)}</time>
                  <small>{formatCountdown(keyReset.resetsAt)}</small>
                </>
              ) : <strong>{isAntigravity ? "No active reset" : "Not reported"}</strong>}
            </div>
          </div>
        </div>
      ) : null}

      {isReady ? (
        <>
          {provider.windows.length ? (
            <div className="window-list">
              {provider.windows.map((window) => (
                <WindowRow
                  key={window.id}
                  window={window}
                  reset={lookupReset(resets, provider.id, window)}
                  compact={isSingleWindow}
                  showReset={!isSingleWindow && provider.id !== "cursor" && (!isAntigravity || Boolean(window.resetsAt))}
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
          {provider.message ? (
            <div className="provider-notice">
              <span aria-hidden="true">i</span>
              <p>{provider.message}</p>
            </div>
          ) : null}
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

      {provider.balance ? (
        <div className="balance-chip">
          <span>{provider.balance.label}</span>
          <b>{provider.balance.unit === "tokens"
            ? `${provider.balance.approximate ? "≈" : ""}${formatTokens(provider.balance.value)} tokens`
            : formatBalance(provider.balance.value, provider.balance.unit)}</b>
        </div>
      ) : null}

      {usageDetails?.length ? (
        <dl className="provider-metrics">
          {usageDetails.map(({ label, value }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {provider.readings?.length ? (
        <details className="provider-disclosure provider-readings">
          <summary>Source readings</summary>
          {provider.readings.map((reading) => (
            <section key={reading.id}>
              <h3>{reading.name}</h3>
              <p>{reading.scope}{reading.updatedAt ? ` · ${formatAge(reading.updatedAt)}` : ""}</p>
              <dl className="provider-metrics">
                {reading.windows.map((window) => (
                  <div key={window.id}>
                    <dt>{window.label}</dt>
                    <dd title={window.usedPercent === null ? undefined : `${window.usedPercent}%`}>
                      {formatPercent(window.usedPercent, reading.id === "grok-bot" ? 4 : 0)}{window.usedPercent === null ? "" : " used"}
                    </dd>
                  </div>
                ))}
                {reading.windows.filter((window) => window.resetsAt).map((window) => (
                  <div key={`${window.id}-reset`}>
                    <dt>Resets</dt>
                    <dd>{formatUpdated(window.resetsAt)}</dd>
                  </div>
                ))}
                {reading.details.map(({ label, value }) => (
                  <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
                ))}
              </dl>
              {reading.message ? <p>{reading.message}</p> : null}
            </section>
          ))}
        </details>
      ) : null}

      {tokenEstimates.length ? (
        <details className="provider-disclosure">
          <summary>Token usage details</summary>
          <ProviderTokenPanel estimates={tokenEstimates} preferred={getPreferredTokenUsage(provider)} />
        </details>
      ) : null}

      <footer className="provider-card__footer">
        {isManual ? null : <div>
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
        </div>}
        <div className="source-meta">
          <span>{provider.source}</span>
          <small title={formatUpdated(provider.updatedAt)}>
            {isManual
              ? provider.updatedAt ? `Updated ${formatUpdated(provider.updatedAt)}` : "No snapshot saved"
              : formatAge(provider.updatedAt)}
          </small>
        </div>
      </footer>
    </article>
  );
});
