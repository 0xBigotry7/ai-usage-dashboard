import Link from "next/link";
import { useEffect, useState } from "react";
import { formatAge } from "../../lib/format";
import {
  isProviderStale,
  type ResetLookup,
} from "../../lib/provider-selectors";
import type { Provider, UsagePayload } from "../../lib/usage-types";
import { REFRESH_SECONDS } from "../hooks/use-usage-data";
import { useWakeLock } from "../hooks/use-wake-lock";
import { DisplayProviderTile } from "./DisplayProviderTile";
import { RefreshCountdown } from "./RefreshCountdown";

export function DedicatedDisplay({
  data,
  providers,
  resets,
  error,
  refreshSignal,
  warningThreshold,
  onRefresh,
}: {
  data: UsagePayload | null;
  providers: Provider[];
  resets: ResetLookup;
  error: string | null;
  refreshSignal: number;
  warningThreshold: number;
  onRefresh: () => void;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(3);
  const { wakeLockActive, toggleWakeLock } = useWakeLock();
  const [fullscreen, setFullscreen] = useState(false);
  const [clock, setClock] = useState("--:--");

  useEffect(() => {
    const updatePageSize = () => setPageSize(window.innerWidth >= 680 ? 4 : 3);
    updatePageSize();
    window.addEventListener("resize", updatePageSize);
    return () => window.removeEventListener("resize", updatePageSize);
  }, []);

  useEffect(() => {
    const updateClock = () =>
      setClock(
        new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date()),
      );
    updateClock();
    const timer = window.setInterval(updateClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const pageCount = Math.max(1, Math.ceil(providers.length / pageSize));
  const activePage = page % pageCount;
  const visible = providers.slice(
    activePage * pageSize,
    (activePage + 1) * pageSize,
  );

  useEffect(() => {
    if (pageCount <= 1) return;
    const timer = window.setInterval(
      () => setPage((value) => (value + 1) % pageCount),
      8_000,
    );
    return () => window.clearInterval(timer);
  }, [pageCount]);

  useEffect(() => {
    const handleFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreen);
  }, []);

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  const staleCount = providers.filter(isProviderStale).length;
  return (
    <section className="dedicated-display" aria-label="External always-on display">
      <header className="display-header">
        <div className="display-brand">
          <span className="brand__signal" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>AI USAGE</strong>
            <small>
              {error
                ? "Collector offline"
                : staleCount
                  ? `${providers.length - staleCount} live · ${staleCount} stale`
                  : `${providers.length} providers live`}
            </small>
          </span>
        </div>
        <div className="display-clock">
          <strong>{clock}</strong>
          <small>
            refresh in{" "}
            <RefreshCountdown key={refreshSignal} seconds={REFRESH_SECONDS} />
          </small>
        </div>
        <nav className="display-actions" aria-label="Display controls">
          <button
            type="button"
            className={wakeLockActive ? "is-active" : ""}
            onClick={() => void toggleWakeLock()}
            title="Keep the screen awake"
          >
            Awake
          </button>
          <button type="button" onClick={() => void toggleFullscreen()}>
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
          <Link href="/">Dashboard</Link>
        </nav>
      </header>

      <div
        className="display-grid"
        aria-live="polite"
        style={
          {
            "--display-columns": Math.max(1, visible.length),
          } as React.CSSProperties
        }
      >
        {visible.length ? (
          visible.map((provider) => (
            <DisplayProviderTile
              key={provider.id}
              provider={provider}
              resets={resets}
              warningThreshold={warningThreshold}
            />
          ))
        ) : (
          <div className="display-empty">
            <strong>
              {error
                ? "Collector temporarily unavailable"
                : "Waiting for the first usage snapshot"}
            </strong>
            <span>
              {error ||
                "Data appears automatically when it arrives — no page refresh needed."}
            </span>
          </div>
        )}
      </div>

      <footer className="display-footer">
        <span>
          {data?.generatedAt
            ? `Snapshot ${formatAge(data.generatedAt)}`
            : "Connecting to local collector"}
        </span>
        {pageCount > 1 ? (
          <div aria-label="Provider pages">
            {Array.from({ length: pageCount }, (_, index) => (
              <button
                key={index}
                type="button"
                className={activePage === index ? "is-active" : ""}
                onClick={() => setPage(index)}
                aria-label={`Show page ${index + 1}`}
                aria-pressed={activePage === index}
              />
            ))}
          </div>
        ) : null}
        <span>Optimized for 480×320 · 800×480</span>
      </footer>
    </section>
  );
}
