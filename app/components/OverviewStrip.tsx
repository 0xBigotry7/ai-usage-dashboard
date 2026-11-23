import { memo, useMemo } from "react";
import { formatCountdown, formatUpdated } from "../../lib/format";
import {
  healthSummary,
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
  now,
  unreachable,
}: {
  data: UsagePayload | null;
  /** Providers currently visible on the dashboard. */
  providers: Provider[];
  resets: ResetLookup;
  riskCount: number;
  /** Ticking clock from useUsageData, so the counts age without new data. */
  now: number;
  /** The last load failed; what is on screen is the previous snapshot. */
  unreachable: boolean;
}) {
  const health = useMemo(() => healthSummary(providers, now), [providers, now]);

  const nextReset = useMemo(() => {
    const upcoming = providers.flatMap((provider) =>
      provider.windows.map((window) => ({
        ...lookupReset(resets, provider.id, window),
        window,
      })),
    );
    return pickNextReset(upcoming, now);
  }, [now, resets, providers]);

  return (
    <section className="overview-strip" aria-label="Collector status">
      <div>
        <span className="overview-strip__dot" />
        <p>
          <b>
            {unreachable
              ? "Collector unreachable"
              : !data || data.collector.state === "starting"
                ? "Waiting for collector"
                : health.stale || health.unavailable
                  ? health.text
                  : riskCount
                    ? `${riskCount} provider${
                        riskCount > 1 ? "s" : ""
                      } need attention`
                    : "Collecting live"}
          </b>
          <span>
            {providers.map((provider) => provider.name).join(" · ") ||
              "Waiting for data"}
          </span>
        </p>
      </div>
      <div className="overview-strip__reset">
        <span className="eyebrow">Collector checked</span>
        <strong>{formatUpdated(data?.generatedAt || null)}</strong>
      </div>
      <div className="overview-strip__reset">
        <span className="eyebrow">Next reset</span>
        <strong>
          {nextReset?.estimated ? "est. " : ""}
          {nextReset ? formatCountdown(nextReset.resetsAt, now) : "waiting for data"}
        </strong>
      </div>
      <div className="privacy-lock">
        <span aria-hidden="true">●</span>
        Credentials never leave this machine
      </div>
    </section>
  );
});
