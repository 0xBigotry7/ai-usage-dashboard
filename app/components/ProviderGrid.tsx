import { memo } from "react";
import type { ResetLookup } from "../../lib/provider-selectors";
import type { HistoryPoint, Provider } from "../../lib/usage-types";
import { LoadingCard } from "./LoadingCard";
import { ProviderCard } from "./ProviderCard";

export const ProviderGrid = memo(function ProviderGrid({
  providers,
  hasProviders,
  error,
  history,
  resets,
  warningThreshold,
  onOpenControls,
  onRetry,
}: {
  /** Providers currently visible on the dashboard. */
  providers: Provider[];
  /** Whether the payload reported any providers at all, visible or hidden. */
  hasProviders: boolean;
  error: string | null;
  history: HistoryPoint[];
  resets: ResetLookup;
  warningThreshold: number;
  onOpenControls: () => void;
  onRetry: () => void;
}) {
  return (
    <section className="provider-grid" aria-label="AI provider usage">
      {providers.length ? (
        providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            history={history}
            resets={resets}
            warningThreshold={warningThreshold}
          />
        ))
      ) : hasProviders ? (
        <div className="provider-empty-state">
          <span aria-hidden="true">◌</span>
          <strong>All providers are hidden</strong>
          <p>Re-enable at least one provider under Manage.</p>
          <button type="button" onClick={onOpenControls}>
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
          <button type="button" onClick={onRetry}>
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
  );
});
