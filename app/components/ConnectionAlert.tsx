import { memo } from "react";

/** Inline alert shown when the usage collector cannot be reached. */
export const ConnectionAlert = memo(function ConnectionAlert({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  if (!error) return null;
  return (
    <div className="connection-alert" role="alert">
      <span aria-hidden="true">!</span>
      <div>
        <strong>Collector not connected</strong>
        <p>{error}</p>
      </div>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
});
