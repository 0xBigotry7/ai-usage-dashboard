import { useMemo } from "react";
import type { CopySummaryInput } from "../../lib/copy-summary";
import { buildResetLookup, providerRisk } from "../../lib/provider-selectors";
import type { HistoryPoint, UsagePayload } from "../../lib/usage-types";

/**
 * Memoized read-models over the usage payload that multiple dashboard
 * sections share: hidden-provider filtering, the per-window reset lookup,
 * the warning-risk count, and the copy-summary input.
 */
export function useDashboardModel({
  data,
  history,
  hiddenProviders,
  warningThreshold,
}: {
  data: UsagePayload | null;
  history: HistoryPoint[];
  hiddenProviders: string[];
  warningThreshold: number;
}) {
  const visibleProviders = useMemo(
    () =>
      (data?.providers || []).filter(
        (provider) => !hiddenProviders.includes(provider.id),
      ),
    [data, hiddenProviders],
  );

  // Resolve every reset once per payload; cards, the next-reset overview,
  // and the copy summary all read this map instead of re-deriving.
  const resolvedResets = useMemo(
    () => buildResetLookup(data?.providers || [], history),
    [data, history],
  );

  const riskCount = useMemo(
    () =>
      visibleProviders.filter(
        (provider) => providerRisk(provider, warningThreshold) !== "normal",
      ).length,
    [visibleProviders, warningThreshold],
  );

  const summary = useMemo<CopySummaryInput | null>(
    () =>
      data
        ? {
            generatedAt: data.generatedAt,
            providers: visibleProviders,
            resets: resolvedResets,
          }
        : null,
    [data, visibleProviders, resolvedResets],
  );

  return { visibleProviders, resolvedResets, riskCount, summary };
}
