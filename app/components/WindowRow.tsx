import {
  clamp,
  formatCountdown,
  formatNumber,
  formatPercent,
  formatResetClock,
} from "../../lib/format";
import type { ResolvedReset } from "../../lib/provider-selectors";
import type { WindowUsage } from "../../lib/usage-types";

export function WindowRow({
  window,
  reset,
}: {
  window: WindowUsage;
  reset: ResolvedReset;
}) {
  const percent = window.usedPercent ?? 0;
  return (
    <div className="window-row">
      <div className="window-row__top">
        <div>
          <span className="window-row__label">{window.label}</span>
          <span className="window-row__reset">
            {reset.estimated && reset.resetsAt ? "est. " : ""}
            {formatCountdown(reset.resetsAt)}
          </span>
        </div>
        <span className="window-row__percent">
          {formatPercent(window.usedPercent)}
        </span>
      </div>
      <div
        className="meter"
        role="progressbar"
        aria-label={`${window.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent ?? undefined}
      >
        <span style={{ width: `${clamp(percent)}%` }} />
      </div>
      <div className="window-row__detail">
        <span>
          Resets {reset.estimated && reset.resetsAt ? "~" : ""}
          {formatResetClock(reset.resetsAt)}
          {reset.estimated && reset.resetsAt ? " · estimated from history" : ""}
        </span>
        {window.limit !== null ? (
          <span>
            {formatNumber(window.used)} / {formatNumber(window.limit)}
          </span>
        ) : (
          <span>Provider-reported quota</span>
        )}
      </div>
    </div>
  );
}
