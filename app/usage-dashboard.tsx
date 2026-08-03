"use client";

import { useCallback, useState } from "react";
import { AccessGate } from "./components/AccessGate";
import { ConnectionAlert } from "./components/ConnectionAlert";
import { ControlDock } from "./components/ControlDock";
import { DashboardFooter } from "./components/DashboardFooter";
import { DedicatedDisplay } from "./components/DedicatedDisplay";
import { OverviewStrip } from "./components/OverviewStrip";
import { ProviderGrid } from "./components/ProviderGrid";
import { TokenOverview } from "./components/TokenOverview";
import { Topbar } from "./components/Topbar";
import { useDashboardModel } from "./hooks/use-dashboard-model";
import { useDashboardShortcuts } from "./hooks/use-dashboard-shortcuts";
import { usePreferences } from "./hooks/use-preferences";
import { useUsageData } from "./hooks/use-usage-data";

export function UsageDashboard({
  displayMode = false,
}: {
  displayMode?: boolean;
} = {}) {
  const {
    warningThreshold,
    hiddenProviders,
    chooseWarningThreshold,
    toggleProvider,
  } = usePreferences();
  const {
    data,
    history,
    historyTruncated,
    error,
    refreshing,
    refreshSignal,
    locked,
    setLocked,
    load,
  } = useUsageData();
  const [controlsOpen, setControlsOpen] = useState(false);

  const { visibleProviders, resolvedResets, riskCount, summary } =
    useDashboardModel({ data, history, hiddenProviders, warningThreshold });

  const refresh = useCallback(() => void load(true), [load]);
  const toggleControls = useCallback(
    () => setControlsOpen((value) => !value),
    [],
  );
  const openControls = useCallback(() => setControlsOpen(true), []);
  const handleUnlocked = useCallback(async () => {
    setLocked(false);
    await load();
  }, [load, setLocked]);

  useDashboardShortcuts({
    displayMode,
    onRefresh: refresh,
    onToggleControls: toggleControls,
  });

  return (
    <main className={displayMode ? "dashboard dashboard--display" : "dashboard"}>
      <a className="skip-link" href="#dashboard-content">
        Skip to main content
      </a>
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />

      <div className="dashboard__shell">
        {locked ? <AccessGate onUnlocked={handleUnlocked} /> : null}

        <div
          className={
            locked
              ? "dashboard__content dashboard__content--locked"
              : "dashboard__content"
          }
          id="dashboard-content"
          inert={locked ? true : undefined}
        >
          {displayMode ? (
            <DedicatedDisplay
              data={data}
              providers={visibleProviders}
              resets={resolvedResets}
              error={error}
              refreshSignal={refreshSignal}
              warningThreshold={warningThreshold}
              onRefresh={refresh}
            />
          ) : (
            <>
              <Topbar
                summary={summary}
                controlsOpen={controlsOpen}
                onToggleControls={toggleControls}
                refreshing={refreshing}
                refreshSignal={refreshSignal}
                onRefresh={refresh}
              />

              {controlsOpen ? (
                <ControlDock
                  providers={data?.providers || []}
                  hiddenProviders={hiddenProviders}
                  warningThreshold={warningThreshold}
                  riskCount={riskCount}
                  onToggleProvider={toggleProvider}
                  onChooseWarningThreshold={chooseWarningThreshold}
                />
              ) : null}

              <OverviewStrip
                data={data}
                providers={visibleProviders}
                resets={resolvedResets}
                riskCount={riskCount}
              />

              <TokenOverview providers={visibleProviders} />

              <ConnectionAlert error={error} onRetry={refresh} />

              <ProviderGrid
                providers={visibleProviders}
                hasProviders={Boolean(data?.providers.length)}
                error={error}
                history={history}
                resets={resolvedResets}
                warningThreshold={warningThreshold}
                onOpenControls={openControls}
                onRetry={refresh}
              />

              {historyTruncated ? (
                <p className="history-truncated" role="note">
                  History truncated; showing only the most recent data
                </p>
              ) : null}

              <DashboardFooter collectorVersion={data?.collector.version} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
