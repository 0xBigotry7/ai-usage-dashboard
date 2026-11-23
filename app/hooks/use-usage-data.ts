import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryPoint, UsagePayload } from "../../lib/usage-types";

export const REFRESH_SECONDS = 60;
// How often ages and staleness are re-evaluated between loads.
const CLOCK_TICK_MS = 30_000;

function getApiBase() {
  if (typeof window === "undefined") return "";
  return window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:4317"
    : "";
}

/**
 * Owns loading the usage snapshot and history: the initial deferred fetch,
 * the 60s poll, stale-response protection (sequence guard + abort), the
 * visibility-triggered refetch, and the cloud view-code lock state.
 *
 * `now` ticks on its own, so "5m ago" keeps counting and a card turns stale
 * even while the collector cannot be reached and no new data arrives.
 */
export function useUsageData() {
  const [data, setData] = useState<UsagePayload | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [locked, setLocked] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const manualLoadRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const lastLoadedAtRef = useRef(0);

  const load = useCallback(async (manual = false) => {
    // A slow older response must never overwrite a newer one: bump the
    // sequence, abort the in-flight fetch, and ignore superseded results.
    const sequence = ++loadSequenceRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    if (manual) {
      manualLoadRef.current = true;
      setRefreshing(true);
    }
    try {
      const apiBase = getApiBase();
      const isLocalCollector = apiBase.length > 0;
      const [usageResponse, historyResponse] = await Promise.all([
        manual && isLocalCollector
          ? fetch(`${apiBase}/api/refresh`, {
              method: "POST",
              signal: controller.signal,
            })
          : fetch(`${apiBase}/api/usage`, {
              cache: "no-store",
              signal: controller.signal,
            }),
        fetch(`${apiBase}/api/history?hours=168`, {
          cache: "no-store",
          signal: controller.signal,
        }).catch(() => null),
      ]);
      if (sequence !== loadSequenceRef.current) return;
      if (usageResponse.status === 401 && !isLocalCollector) {
        setLocked(true);
        setData(null);
        setError(null);
        return;
      }
      if (!usageResponse.ok) {
        throw new Error("Usage service returned an error");
      }
      // History only feeds the trend bars and reset estimates. If it fails,
      // keep the previous history rather than holding back fresh usage.
      const [usagePayload, historyPayload] = await Promise.all([
        usageResponse.json() as Promise<UsagePayload>,
        historyResponse?.ok
          ? (historyResponse.json() as Promise<{
              points?: HistoryPoint[];
              truncated?: boolean;
            }>).catch(() => null)
          : null,
      ]);
      if (sequence !== loadSequenceRef.current) return;
      setData(usagePayload);
      if (historyPayload) {
        setHistory(historyPayload.points || []);
        setHistoryTruncated(historyPayload.truncated === true);
      }
      setNow(Date.now());
      setLocked(false);
      setError(null);
      lastLoadedAtRef.current = Date.now();
      setRefreshSignal((value) => value + 1);
    } catch {
      if (sequence !== loadSequenceRef.current) return;
      setError("Cannot reach the usage collector right now. Try again shortly.");
    } finally {
      if (sequence === loadSequenceRef.current) {
        manualLoadRef.current = false;
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load(), 0);
    const refreshTimer = window.setInterval(() => {
      // A manual refresh can take a while on the collector; the poll must
      // not abort it and hand back the data from before the refresh.
      if (!manualLoadRef.current) void load();
    }, REFRESH_SECONDS * 1000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [load]);

  useEffect(() => {
    // A wall display or restored tab should show fresh data promptly.
    const handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastLoadedAtRef.current > 30_000
      ) {
        void load();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [load]);

  return {
    data,
    history,
    historyTruncated,
    error,
    refreshing,
    refreshSignal,
    now,
    locked,
    setLocked,
    load,
  };
}
