const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 3_000;
const DEFAULT_BACKOFF_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000];
const DEFAULT_FAILURE_THRESHOLD = 3;

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientError(result) {
  return result?.state === "error" && result?.retryable !== false;
}

function unexpectedProviderError(adapter, error, updatedAt) {
  const status = Number(error?.status);
  const authError = status === 401 || status === 403;
  return {
    id: adapter.id,
    name: adapter.name,
    shortName: adapter.shortName || adapter.name.slice(0, 2).toUpperCase(),
    accent: adapter.accent || "#7bf1a8",
    state: authError ? "auth_error" : "error",
    plan: null,
    source: adapter.name,
    updatedAt,
    windows: [],
    balance: null,
    message: error?.message || "适配器暂时不可用",
    retryable: !authError && (!status || status === 408 || status === 429 || status >= 500),
  };
}

function staleResult(lastReady, failedResult, failureCount, failureThreshold) {
  const retryMessage = `旧数据 · 重试中（${failureCount}/${failureThreshold}）：${
    failedResult.message || "暂时无法取得配额数据"
  }`;
  return {
    ...lastReady,
    message: [lastReady.message, retryMessage].filter(Boolean).join(" · "),
  };
}

export function createProviderRefreshCoordinator({
  now = Date.now,
  wait = waitFor,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  backoffMs = DEFAULT_BACKOFF_MS,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
} = {}) {
  const providerState = new Map();

  function currentTime() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  async function collectOnce(adapter, env) {
    try {
      return await adapter.collect(env);
    } catch (error) {
      console.warn(
        `适配器 ${adapter.id} 意外抛出：${error?.message || "未知错误"}`,
      );
      return unexpectedProviderError(
        adapter,
        error,
        new Date(currentTime()).toISOString(),
      );
    }
  }

  function acceptResult(state, result, intervalMs) {
    state.failureCount = 0;
    state.lastResult = result;
    state.nextAttemptAt = currentTime() + intervalMs;
    if (result?.state === "ready") state.lastReady = result;
    return result;
  }

  async function collectAdapter(adapter, env, force) {
    const state = providerState.get(adapter.id) || {
      failureCount: 0,
      lastReady: null,
      lastResult: null,
      nextManualAttemptAt: 0,
      nextAttemptAt: 0,
    };
    providerState.set(adapter.id, state);

    const intervalMs = adapter.pollIntervalMs || pollIntervalMs;
    const nowMs = currentTime();
    const configurationFailure =
      state.lastResult?.state === "auth_error" ||
      state.lastResult?.state === "needs_configuration";
    const canRetryConfiguration =
      force &&
      configurationFailure &&
      nowMs >= state.nextManualAttemptAt;
    if (
      state.lastResult &&
      nowMs < state.nextAttemptAt &&
      !canRetryConfiguration
    ) {
      return state.lastResult;
    }
    if (force && configurationFailure) {
      state.nextManualAttemptAt = nowMs + intervalMs;
    }

    let result = await collectOnce(adapter, env);
    if (!isTransientError(result)) {
      return acceptResult(state, result, intervalMs);
    }

    await wait(retryDelayMs);
    result = await collectOnce(adapter, env);
    if (!isTransientError(result)) {
      return acceptResult(state, result, intervalMs);
    }

    state.failureCount += 1;
    const backoffIndex = Math.min(
      state.failureCount - 1,
      Math.max(0, backoffMs.length - 1),
    );
    state.nextAttemptAt =
      currentTime() + (backoffMs[backoffIndex] || intervalMs);

    if (state.lastReady && state.failureCount < failureThreshold) {
      state.lastResult = staleResult(
        state.lastReady,
        result,
        state.failureCount,
        failureThreshold,
      );
      return state.lastResult;
    }

    state.lastResult = result;
    return result;
  }

  return {
    async collect(adapters, env = process.env, { force = false } = {}) {
      return Promise.all(
        adapters.map((adapter) => collectAdapter(adapter, env, force)),
      );
    },
  };
}
