import { memo } from "react";
import { exactTokens, formatTokens } from "../../lib/format";
import {
  getTokenEstimates,
  tokenScopeLabel,
} from "../../lib/provider-selectors";
import type { Provider, TokenUsage } from "../../lib/usage-types";
import { TokenComposition } from "./TokenComposition";

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

export const TokenOverview = memo(function TokenOverview({
  providers,
}: {
  providers: Provider[];
}) {
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
});
