import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryPoint, UsagePayload } from "../../lib/usage-types";

export const REFRESH_SECONDS = 60;

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
 */
export function useUsageData() {
  const [data, setData] = useState<UsagePayload | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [locked, setLocked] = useState(false);
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
    if (manual) setRefreshing(true);
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
        }),
      ]);
      if (sequence !== loadSequenceRef.current) return;
      if (usageResponse.status === 401 && !isLocalCollector) {
        setLocked(true);
        setData(null);
        setError(null);
        return;
      }
      if (!usageResponse.ok || !historyResponse.ok) {
        throw new Error("Usage service returned an error");
      }
      const [usagePayload, historyPayload] = await Promise.all([
        usageResponse.json() as Promise<UsagePayload>,
        historyResponse.json() as Promise<{
          points?: HistoryPoint[];
          truncated?: boolean;
        }>,
      ]);
      if (sequence !== loadSequenceRef.current) return;
      setData(usagePayload);
      setHistory(historyPayload.points || []);
      setHistoryTruncated(historyPayload.truncated === true);
      setLocked(false);
      setError(null);
      lastLoadedAtRef.current = Date.now();
      setRefreshSignal((value) => value + 1);
    } catch {
      if (sequence !== loadSequenceRef.current) return;
      setError("Cannot reach the usage collector right now. Try again shortly.");
    } finally {
      if (sequence === loadSequenceRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load(), 0);
    const refreshTimer = window.setInterval(() => void load(), REFRESH_SECONDS * 1000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
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
    locked,
    setLocked,
    load,
  };
}
