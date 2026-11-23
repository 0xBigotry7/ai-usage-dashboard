import { memo } from "react";
import {
  clamp,
  formatAge,
  formatBalance,
  formatPercent,
  formatQuotaReset,
  formatResetDate,
  formatTokens,
} from "../../lib/format";
import {
  getPeakWindow,
  getPreferredTokenUsage,
  isWindowExpired,
  lookupReset,
  providerHealth,
  providerRisk,
  providerStateLabel,
  type ResetLookup,
} from "../../lib/provider-selectors";
import type { Provider } from "../../lib/usage-types";
import { ProviderLogo, brandAccent } from "../provider-logo";

export const DisplayProviderTile = memo(function DisplayProviderTile({
  provider,
  resets,
  warningThreshold,
  now,
}: {
  provider: Provider;
  resets: ResetLookup;
  warningThreshold: number;
  /** Ticking clock from useUsageData; ages and staleness follow it. */
  now: number;
}) {
  const windows = provider.windows
    .filter((window) => window.usedPercent !== null)
    .slice(0, 3);
  const usage = getPreferredTokenUsage(provider);
  const models = usage?.models.slice(0, 2) || [];
  const risk = providerRisk(provider, warningThreshold);
  const health = providerHealth(provider, now);
  const stale = health === "stale";
  const peak = getPeakWindow(provider);

  return (
    <article
      className={`display-provider display-provider--${risk} ${stale ? "display-provider--stale" : ""}`}
      data-provider={provider.id}
      style={{ "--provider-accent": brandAccent(provider) } as React.CSSProperties}
    >
      <header className="display-provider__header">
        <div>
          <ProviderLogo provider={provider} className="provider-logo--display" />
          <span>
            <strong>{provider.name}</strong>
            <small>{provider.plan || providerStateLabel(provider, now)}</small>
          </span>
        </div>
        <span className="display-provider__state">
          {health === "unavailable"
            ? "UNAVAILABLE"
            : stale
              ? "STALE"
              : peak && risk !== "normal"
                ? `${peak.label} · low quota`
                : "LIVE"}
        </span>
      </header>

      {windows.length ? (
        <div className="display-windows">
          {windows.map((window) => {
            const reset = lookupReset(resets, provider.id, window);
            const remaining = clamp(100 - (window.usedPercent ?? 0));
            return (
              <div className="display-window" key={window.id}>
                <span title={window.label}>{window.label}</span>
                <strong>{formatPercent(remaining)} <small>remaining</small></strong>
                <div
                  className="display-meter"
                  role="progressbar"
                  aria-label={`${provider.name} ${window.label} remaining`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={remaining}
                >
                  <i style={{ width: `${remaining}%` }} />
                </div>
                <small>
                  {isWindowExpired(window, now) ? "Reset passed · awaiting refresh" : window.resetDate ? `Resets ${formatResetDate(window.resetDate)}` : reset.resetsAt
                    ? `${reset.estimated ? "Est. reset" : "Resets"} ${formatQuotaReset(reset.resetsAt)}`
                    : "No reset reported"}
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
          <strong>{providerStateLabel(provider, now)}</strong>
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
          {formatAge(provider.updatedAt, now)}
        </span>
      </footer>
    </article>
  );
});
