import {
  clamp,
  formatNumber,
  formatPercent,
  formatQuotaReset,
  formatResetDate,
} from "../../lib/format";
import type { ResolvedReset } from "../../lib/provider-selectors";
import type { WindowUsage } from "../../lib/usage-types";

export function WindowRow({
  window,
  reset,
  showReset = true,
  compact = false,
}: {
  window: WindowUsage;
  reset: ResolvedReset;
  showReset?: boolean;
  compact?: boolean;
}) {
  const remaining = clamp(100 - (window.usedPercent ?? 0));
  const hasReset = showReset && (window.resetDate || reset.resetsAt);
  return (
    <div className={compact ? "window-row window-row--compact" : "window-row"}>
      {!compact ? <div className="window-row__top">
        <span className="window-row__label">{window.label}</span>
        {window.usedPercent !== null ? (
          <div className="window-row__figures">
            <span><b>{formatPercent(remaining)}</b> remaining</span>
          </div>
        ) : null}
      </div> : null}
      {window.usedPercent !== null ? <div
        className="meter"
        role="progressbar"
        aria-label={`${window.label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
      >
        <span style={{ width: `${remaining}%` }} />
      </div> : null}
      {hasReset || window.limit !== null ? <div className="window-row__detail">
        {hasReset ? <span>
          {reset.estimated ? "Estimated reset " : "Resets "}
          <time dateTime={window.resetDate ?? reset.resetsAt ?? undefined}>
            {window.resetDate ? formatResetDate(window.resetDate) : reset.resetsAt ? formatQuotaReset(reset.resetsAt) : null}
          </time>
        </span> : null}
        {window.limit !== null ? (
          <span>
            {formatNumber(window.used)} / {formatNumber(window.limit)}
          </span>
        ) : null}
      </div> : null}
    </div>
  );
}
