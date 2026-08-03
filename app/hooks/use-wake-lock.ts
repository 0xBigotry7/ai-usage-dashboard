import { useCallback, useEffect, useRef, useState } from "react";

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
};

/**
 * Screen wake lock for the dedicated display: user-toggled, re-acquired when
 * the tab becomes visible again, and released on unmount.
 */
export function useWakeLock() {
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const wakeLockWantedRef = useRef(false);

  const acquireWakeLock = useCallback(async () => {
    const navigatorWithWakeLock = navigator as Navigator & {
      wakeLock?: {
        request: (type: "screen") => Promise<WakeLockSentinelLike>;
      };
    };
    if (!navigatorWithWakeLock.wakeLock) return false;
    try {
      const sentinel = await navigatorWithWakeLock.wakeLock.request("screen");
      wakeLockRef.current = sentinel;
      setWakeLockActive(true);
      // The browser can release the lock on its own (tab hidden, battery);
      // mirror that into state so the button never shows a dead lock.
      sentinel.addEventListener?.("release", () => {
        if (wakeLockRef.current === sentinel) {
          wakeLockRef.current = null;
          setWakeLockActive(false);
        }
      });
      return true;
    } catch {
      wakeLockRef.current = null;
      setWakeLockActive(false);
      return false;
    }
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        wakeLockWantedRef.current &&
        !wakeLockRef.current
      ) {
        void acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [acquireWakeLock]);

  useEffect(
    () => () => {
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      if (sentinel && !sentinel.released) void sentinel.release();
    },
    [],
  );

  async function toggleWakeLock() {
    if (wakeLockWantedRef.current) {
      wakeLockWantedRef.current = false;
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      setWakeLockActive(false);
      if (sentinel && !sentinel.released) await sentinel.release();
      return;
    }
    wakeLockWantedRef.current = await acquireWakeLock();
  }

  return { wakeLockActive, toggleWakeLock };
}
