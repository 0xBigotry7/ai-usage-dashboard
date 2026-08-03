import { memo, useMemo } from "react";
import { formatCountdown, formatUpdated } from "../../lib/format";
import {
  isProviderStale,
  lookupReset,
  pickNextReset,
  type ResetLookup,
} from "../../lib/provider-selectors";
import type { Provider, UsagePayload } from "../../lib/usage-types";

export const OverviewStrip = memo(function OverviewStrip({
  data,
  providers,
  resets,
  riskCount,
}: {
  data: UsagePayload | null;
  /** Providers currently visible on the dashboard. */
  providers: Provider[];
  resets: ResetLookup;
  riskCount: number;
}) {
  const staleProviders = useMemo(
    () => providers.filter(isProviderStale),
    [providers],
  );

  const nextReset = useMemo(() => {
    const generatedAt = new Date(data?.generatedAt || 0).getTime();
    const upcoming = providers.flatMap((provider) =>
      provider.windows.map((window) => ({
        ...lookupReset(resets, provider.id, window),
        window,
      })),
    );
    return pickNextReset(upcoming, generatedAt);
  }, [data?.generatedAt, resets, providers]);

  return (
    <section className="overview-strip" aria-label="Collector status">
      <div>
        <span className="overview-strip__dot" />
        <p>
          <b>
            {data?.collector.state === "online"
              ? staleProviders.length
                ? `${providers.length - staleProviders.length} live · ${staleProviders.length} stale`
                : riskCount
                  ? `${riskCount} provider${
                      riskCount > 1 ? "s" : ""
                    } need attention`
                  : "Collecting live"
              : "Waiting for collector"}
          </b>
          <span>
            {providers.map((provider) => provider.name).join(" · ") ||
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
  );
});
