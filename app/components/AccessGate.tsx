import { useState } from "react";
import type { FormEvent } from "react";

/**
 * Cloud view-code gate. Owns the unlock form state and the /api/session
 * exchange; calls onUnlocked once the session cookie is set.
 */
export function AccessGate({
  onUnlocked,
}: {
  onUnlocked: () => Promise<void>;
}) {
  const [viewCode, setViewCode] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  async function unlock(event: FormEvent<HTMLFormElement>) {
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
      await onUnlocked();
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
      <form onSubmit={unlock}>
        <label htmlFor="view-code">View code</label>
        <input
          id="view-code"
          type="password"
          autoComplete="current-password"
          value={viewCode}
          onChange={(event) => setViewCode(event.target.value)}
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
