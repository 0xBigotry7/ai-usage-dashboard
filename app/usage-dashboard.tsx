"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { version as DASHBOARD_VERSION } from "../package.json";
import {
  formatBalance,
  formatCountdown,
  formatPercent,
  formatUpdated,
} from "../lib/format";
import {
  buildResetLookup,
  getPrimaryWindow,
  isProviderStale,
  lookupReset,
  pickNextReset,
  providerRisk,
  providerStateLabel,
} from "../lib/provider-selectors";
import { AccessGate } from "./components/AccessGate";
import { ControlDock } from "./components/ControlDock";
import { DedicatedDisplay } from "./components/DedicatedDisplay";
import { LoadingCard } from "./components/LoadingCard";
import { ProviderCard } from "./components/ProviderCard";
import { RefreshCountdown } from "./components/RefreshCountdown";
import { TokenOverview } from "./components/TokenOverview";
import { usePreferences } from "./hooks/use-preferences";
import { REFRESH_SECONDS, useUsageData } from "./hooks/use-usage-data";

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
  const [viewCode, setViewCode] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  async function unlock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!viewCode.trim()) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: viewCode }),
      });
      if (!response.ok) {
        throw new Error("Incorrect view code");
      }
      setViewCode("");
      setLocked(false);
      await load();
    } catch (unlockFailure) {
      setUnlockError(
        unlockFailure instanceof Error
          ? unlockFailure.message
          : "Unable to unlock right now",
      );
    } finally {
      setUnlocking(false);
    }
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isTyping || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "r") {
        void load(true);
      }
      if (event.key.toLowerCase() === "d") {
        window.location.href = displayMode ? "/" : "/display";
      }
      if (event.key === ",") {
        setControlsOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [displayMode, load]);

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

  const riskProviders = useMemo(
    () =>
      visibleProviders.filter(
        (provider) => providerRisk(provider, warningThreshold) !== "normal",
      ),
    [visibleProviders, warningThreshold],
  );
  const staleProviders = useMemo(
    () => visibleProviders.filter(isProviderStale),
    [visibleProviders],
  );

  const nextReset = useMemo(() => {
    const generatedAt = new Date(data?.generatedAt || 0).getTime();
    const resets = visibleProviders.flatMap((provider) =>
      provider.windows.map((window) => ({
        ...lookupReset(resolvedResets, provider.id, window),
        window,
      })),
    );
    return pickNextReset(resets, generatedAt);
  }, [data?.generatedAt, resolvedResets, visibleProviders]);

  async function copySummary() {
    if (!data) return;
    const lines = [
      `AI Usage Dashboard · ${formatUpdated(data.generatedAt)}`,
      ...visibleProviders.map((provider) => {
        const primary = getPrimaryWindow(provider);
        const reset = lookupReset(resolvedResets, provider.id, primary);
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
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  }

  return (
    <main className={displayMode ? "dashboard dashboard--display" : "dashboard"}>
      <a className="skip-link" href="#dashboard-content">
        Skip to main content
      </a>
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />

      <div className="dashboard__shell">
        {locked ? (
          <AccessGate
            viewCode={viewCode}
            unlocking={unlocking}
            unlockError={unlockError}
            onViewCodeChange={setViewCode}
            onSubmit={unlock}
          />
        ) : null}

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
            onRefresh={() => void load(true)}
          />
        ) : (
        <>
        <header className="topbar">
          <div className="brand">
            <span className="brand__signal" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div>
              <span className="eyebrow">LOCAL-FIRST · MULTI-PROVIDER</span>
              <h1>AI Usage Dashboard</h1>
            </div>
          </div>

          <div className="topbar__actions">
            <Link
              className="utility-button display-launch"
              href="/display"
              title="Open the standalone view for an external always-on screen"
            >
              <span aria-hidden="true">▣</span>
              Display
            </Link>
            <button
              className="utility-button"
              type="button"
              onClick={() => void copySummary()}
              disabled={!data}
              title="Copy a sanitized usage summary"
              aria-live="polite"
            >
              <span aria-hidden="true">⌘</span>
              {copyState === "copied"
                ? "Copied"
                : copyState === "error"
                  ? "Copy failed"
                  : "Summary"}
            </button>
            <button
              className={`utility-button ${controlsOpen ? "is-active" : ""}`}
              type="button"
              onClick={() => setControlsOpen((value) => !value)}
              aria-expanded={controlsOpen}
              aria-controls="dashboard-controls"
            >
              <span aria-hidden="true">☷</span>
              Manage
            </button>
            <button
              className="refresh-button"
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing}
            >
              <span aria-hidden="true">{refreshing ? "···" : "↻"}</span>
              {refreshing ? (
                "Refreshing"
              ) : (
                <RefreshCountdown
                  key={refreshSignal}
                  seconds={REFRESH_SECONDS}
                />
              )}
            </button>
          </div>
        </header>

        {controlsOpen ? (
          <ControlDock
            providers={data?.providers || []}
            hiddenProviders={hiddenProviders}
            warningThreshold={warningThreshold}
            riskCount={riskProviders.length}
            onToggleProvider={toggleProvider}
            onChooseWarningThreshold={chooseWarningThreshold}
          />
        ) : null}

        <section className="overview-strip" aria-label="Collector status">
          <div>
            <span className="overview-strip__dot" />
            <p>
              <b>
                {data?.collector.state === "online"
                  ? staleProviders.length
                    ? `${visibleProviders.length - staleProviders.length} live · ${staleProviders.length} stale`
                    : riskProviders.length
                      ? `${riskProviders.length} provider${
                          riskProviders.length > 1 ? "s" : ""
                        } need attention`
                      : "Collecting live"
                  : "Waiting for collector"}
              </b>
              <span>
                {visibleProviders.map((provider) => provider.name).join(" · ") ||
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

        <TokenOverview providers={visibleProviders} />

        {error ? (
          <div className="connection-alert" role="alert">
            <span aria-hidden="true">!</span>
            <div>
              <strong>Collector not connected</strong>
              <p>{error}</p>
            </div>
            <button type="button" onClick={() => void load(true)}>
              Retry
            </button>
          </div>
        ) : null}

        <section className="provider-grid" aria-label="AI provider usage">
          {visibleProviders.length ? (
            visibleProviders.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                history={history}
                resets={resolvedResets}
                warningThreshold={warningThreshold}
              />
            ))
          ) : data?.providers.length ? (
            <div className="provider-empty-state">
              <span aria-hidden="true">◌</span>
              <strong>All providers are hidden</strong>
              <p>Re-enable at least one provider under Manage.</p>
              <button type="button" onClick={() => setControlsOpen(true)}>
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
              <button type="button" onClick={() => void load(true)}>
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

        {historyTruncated ? (
          <p className="history-truncated" role="note">
            History truncated; showing only the most recent data
          </p>
        ) : null}

        <footer className="dashboard-footer">
          <p>
            <span />
            Usage layers are never summed · missing observations labeled as such
          </p>
          <p>
            Collector {data?.collector.version || DASHBOARD_VERSION} ·
            auto-refresh every 60s
          </p>
        </footer>
        </>
        )}
        </div>
      </div>
    </main>
  );
}
