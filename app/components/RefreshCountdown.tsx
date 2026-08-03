import { useEffect, useState } from "react";

// Owns the 1s ticker internally so the rest of the tree does not re-render
// every second; mount it with a `key` that changes when a load completes so
// the countdown restarts from the top.
export function RefreshCountdown({ seconds }: { seconds: number }) {
  const [secondsLeft, setSecondsLeft] = useState(seconds);
  useEffect(() => {
    const timer = window.setInterval(
      () => setSecondsLeft((value) => (value <= 1 ? seconds : value - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [seconds]);
  return <>{secondsLeft}s</>;
}
