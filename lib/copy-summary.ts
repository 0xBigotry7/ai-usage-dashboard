/** Builds the sanitized plain-text summary copied from the topbar. */
import {
  clamp,
  formatAge,
  formatBalance,
  formatCountdown,
  formatPercent,
  formatUpdated,
} from "./format";
import {
  getPrimaryWindow,
  lookupReset,
  providerHealth,
  providerStateLabel,
  type ResetLookup,
} from "./provider-selectors";
import type { Provider } from "./usage-types";

export type CopySummaryInput = {
  generatedAt: string;
  /** Providers currently visible on the dashboard. */
  providers: Provider[];
  resets: ResetLookup;
};

export function buildCopySummary({
  generatedAt,
  providers,
  resets,
}: CopySummaryInput): string {
  const lines = [
    `AI Usage Dashboard · ${formatUpdated(generatedAt)}`,
    ...providers.map((provider) => {
      const primary = getPrimaryWindow(provider);
      const reset = lookupReset(resets, provider.id, primary);
      // The same figure the cards show: what is left, not what is used.
      const usage = primary?.usedPercent != null
        ? `${primary.label} ${formatPercent(clamp(100 - primary.usedPercent))} remaining`
        : provider.balance
          ? `${provider.balance.label} ${formatBalance(
              provider.balance.value,
              provider.balance.unit,
            )}`
          : providerStateLabel(provider);
      const health = providerHealth(provider);
      const caveat =
        health === "stale"
          ? ` · stale, read ${formatAge(provider.updatedAt)}`
          : health === "unavailable" && primary
            ? ` · ${providerStateLabel(provider)}`
            : "";
      return `${provider.name}: ${usage}${
        reset.resetsAt ? ` · resets ${formatCountdown(reset.resetsAt)}` : ""
      }${caveat}`;
    }),
  ];
  return lines.join("\n");
}
