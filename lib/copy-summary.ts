/** Builds the sanitized plain-text summary copied from the topbar. */
import {
  formatBalance,
  formatCountdown,
  formatPercent,
  formatUpdated,
} from "./format";
import {
  getPrimaryWindow,
  lookupReset,
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
      const usage = primary
        ? `${primary.label} ${formatPercent(primary.usedPercent)}`
        : provider.balance
          ? `${provider.balance.label} ${formatBalance(
              provider.balance.value,
              provider.balance.unit,
            )}`
          : providerStateLabel(provider);
      return `${provider.name}: ${usage}${
        reset.resetsAt ? ` · resets ${formatCountdown(reset.resetsAt)}` : ""
      }`;
    }),
  ];
  return lines.join("\n");
}
