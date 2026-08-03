import {
  exactTokens,
  formatNumber,
  formatPercent,
  formatShortDate,
  formatTokens,
} from "../../lib/format";
import {
  tokenBasisLabel,
  tokenPeriodLabel,
  tokenScopeLabel,
} from "../../lib/provider-selectors";
import type { TokenUsage } from "../../lib/usage-types";
import { TokenComposition } from "./TokenComposition";

function tokenEstimateKey(usage: TokenUsage, index: number) {
  return [
    usage.basis,
    usage.periodId || usage.windowId || "unspecified",
    usage.scope || "unspecified",
    index,
  ].join(":");
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

export function ProviderTokenPanel({
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
