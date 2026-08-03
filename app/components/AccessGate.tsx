import type { FormEvent } from "react";

export function AccessGate({
  viewCode,
  unlocking,
  unlockError,
  onViewCodeChange,
  onSubmit,
}: {
  viewCode: string;
  unlocking: boolean;
  unlockError: string | null;
  onViewCodeChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="access-gate" aria-labelledby="access-title">
      <span className="access-gate__mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="eyebrow">LOCAL-FIRST · PRIVATE DISPLAY</span>
      <h1 id="access-title">AI Usage Dashboard</h1>
      <p>Enter the view code once; this device stays signed in for 30 days.</p>
      <form onSubmit={onSubmit}>
        <label htmlFor="view-code">View code</label>
        <input
          id="view-code"
          type="password"
          autoComplete="current-password"
          value={viewCode}
          onChange={(event) => onViewCodeChange(event.target.value)}
          placeholder="Enter the view code generated on your machine"
          required
        />
        <button type="submit" disabled={unlocking}>
          {unlocking ? "Verifying…" : "Open dashboard"}
        </button>
      </form>
      {unlockError ? (
        <div className="access-gate__error" role="alert">
          {unlockError}
        </div>
      ) : null}
      <small>
        This page only receives sanitized quota snapshots. No AI provider
        credentials are stored.
      </small>
    </section>
  );
}
