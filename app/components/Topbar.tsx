import Link from "next/link";
import { memo, useState } from "react";
import {
  buildCopySummary,
  type CopySummaryInput,
} from "../../lib/copy-summary";
import { REFRESH_SECONDS } from "../hooks/use-usage-data";
import { RefreshCountdown } from "./RefreshCountdown";

export const Topbar = memo(function Topbar({
  summary,
  controlsOpen,
  onToggleControls,
  refreshing,
  refreshSignal,
  onRefresh,
}: {
  /** Copy-summary input; null until the first usage payload arrives. */
  summary: CopySummaryInput | null;
  controlsOpen: boolean;
  onToggleControls: () => void;
  refreshing: boolean;
  refreshSignal: number;
  onRefresh: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  async function copySummary() {
    if (!summary) return;
    const text = buildCopySummary(summary);
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  }

  return (
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
          disabled={!summary}
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
          onClick={onToggleControls}
          aria-expanded={controlsOpen}
          aria-controls="dashboard-controls"
        >
          <span aria-hidden="true">☷</span>
          Manage
        </button>
        <button
          className="refresh-button"
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <span aria-hidden="true">{refreshing ? "···" : "↻"}</span>
          {refreshing ? (
            "Refreshing"
          ) : (
            <RefreshCountdown key={refreshSignal} seconds={REFRESH_SECONDS} />
          )}
        </button>
      </div>
    </header>
  );
});
