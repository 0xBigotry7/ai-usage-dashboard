import pkg from "../package.json" with { type: "json" };

const PROVIDER_ORDER = [
  "codex",
  "claude",
  "kimi",
  "openai-api",
  "openrouter",
  "github-copilot",
  "deepseek",
];
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PROVIDER_STATES = new Set([
  "ready",
  "needs_configuration",
  "auth_error",
  "error",
]);
const TOKEN_PERIOD_IDS = new Set([
  "today",
  "weekly_cycle",
  "rolling_7d",
  "weekly_quota",
]);
const TOKEN_SCOPES = new Set([
  "local_device",
  "account",
  "calibrated_quota",
]);

function boundedString(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(minimum, Math.min(maximum, number));
}

function safeIso(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function boundedToken(value: unknown) {
  const number = boundedNumber(value, 0, Number.MAX_SAFE_INTEGER);
  return number === null ? 0 : Math.floor(number);
}

function optionalBoundedToken(value: unknown) {
  const number = boundedNumber(value, 0, Number.MAX_SAFE_INTEGER);
  return number === null ? null : Math.floor(number);
}

function sanitizeTokenModel(value: unknown, basis: string) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const id = boundedString(input.id, 80);
  const label = boundedString(input.label, 60);
  const windowId = boundedString(input.windowId, 40);
  const inputTokens = optionalBoundedToken(input.inputTokens);
  const outputTokens = optionalBoundedToken(input.outputTokens);
  const reasoningOutputTokens = optionalBoundedToken(
    input.reasoningOutputTokens,
  );
  const cachedInputTokens = optionalBoundedToken(input.cachedInputTokens);
  if (
    !id ||
    !label ||
    !/^[a-zA-Z0-9._:/-]+$/.test(id) ||
    (basis === "quota_percentage" &&
      (!windowId || !/^[a-z0-9_]+$/.test(windowId))) ||
    /[\u0000-\u001f\u007f]/.test(label)
  ) {
    return null;
  }
  return {
    id,
    label,
    ...(windowId ? { windowId } : {}),
    ...(basis === "quota_percentage"
      ? {
          usedPercent: boundedNumber(input.usedPercent, 0, 100) || 0,
          capacityTokens: boundedToken(input.capacityTokens),
        }
      : {}),
    estimatedTokens: boundedToken(input.estimatedTokens),
    ...(basis === "session_logs" || basis === "api_usage"
      ? {
          ...(inputTokens !== null ? { inputTokens } : {}),
          ...(outputTokens !== null ? { outputTokens } : {}),
          ...(reasoningOutputTokens !== null
            ? { reasoningOutputTokens }
            : {}),
        }
      : {}),
    ...(basis === "api_usage"
      ? { requestCount: boundedToken(input.requestCount) }
      : {}),
    ...(basis === "session_logs"
      ? {
          ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
        }
      : {}),
    countedInTotal: input.countedInTotal === true,
  };
}

function sanitizeTokenUsage(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const basis = boundedString(input.basis, 40);
  const rawPeriodId = boundedString(input.periodId, 40);
  const rawScope = boundedString(input.scope, 40);
  const inputTokens = optionalBoundedToken(input.inputTokens);
  const outputTokens = optionalBoundedToken(input.outputTokens);
  const reasoningOutputTokens = optionalBoundedToken(
    input.reasoningOutputTokens,
  );
  const cachedInputTokens = optionalBoundedToken(input.cachedInputTokens);
  if (
    basis !== "quota_percentage" &&
    basis !== "session_logs" &&
    basis !== "api_usage"
  ) {
    return null;
  }
  const models = (Array.isArray(input.models) ? input.models : [])
    .slice(0, 24)
    .map((model) => sanitizeTokenModel(model, basis))
    .filter((model): model is NonNullable<typeof model> => Boolean(model))
    .sort((left, right) => right.estimatedTokens - left.estimatedTokens);
  if (models.length === 0) return null;
  if (basis === "quota_percentage") {
    return {
      basis,
      periodId:
        rawPeriodId && TOKEN_PERIOD_IDS.has(rawPeriodId)
          ? rawPeriodId
          : "weekly_quota",
      scope:
        rawScope && TOKEN_SCOPES.has(rawScope)
          ? rawScope
          : "calibrated_quota",
      estimated: true,
      totalTokens: boundedToken(input.totalTokens),
      capacityTokens: boundedToken(input.capacityTokens),
      usedPercent: boundedNumber(input.usedPercent, 0, 100) || 0,
      windowId: boundedString(input.windowId, 40) || "weekly",
      models,
      assumption:
        boundedString(input.assumption, 240) ||
        "Estimated as weekly quota percentage × subscription capacity.",
    };
  }
  if (basis === "api_usage") {
    return {
      basis,
      periodId:
        rawPeriodId && TOKEN_PERIOD_IDS.has(rawPeriodId)
          ? rawPeriodId
          : "rolling_7d",
      scope:
        rawScope && TOKEN_SCOPES.has(rawScope) ? rawScope : "account",
      estimated: false,
      totalTokens: boundedToken(input.totalTokens),
      ...(inputTokens !== null ? { inputTokens } : {}),
      ...(outputTokens !== null ? { outputTokens } : {}),
      ...(reasoningOutputTokens !== null ? { reasoningOutputTokens } : {}),
      periodSeconds:
        boundedNumber(input.periodSeconds, 60, 31_536_000) || 604_800,
      requestCount: boundedNumber(input.requestCount, 0, 1_000_000_000) || 0,
      models,
      assumption:
        boundedString(input.assumption, 240) ||
        "Per-model usage from the provider's official usage API.",
    };
  }
  return {
    basis,
    periodId:
      rawPeriodId && TOKEN_PERIOD_IDS.has(rawPeriodId)
        ? rawPeriodId
        : "weekly_cycle",
    scope:
      rawScope && TOKEN_SCOPES.has(rawScope) ? rawScope : "local_device",
    estimated: input.estimated === true,
    totalTokens: boundedToken(input.totalTokens),
    ...(inputTokens !== null ? { inputTokens } : {}),
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    ...(outputTokens !== null ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== null ? { reasoningOutputTokens } : {}),
    periodSeconds: boundedNumber(input.periodSeconds, 60, 31_536_000) || 604_800,
    periodStartAt: safeIso(input.periodStartAt),
    sessionCount: boundedNumber(input.sessionCount, 0, 1_000_000) || 0,
    models,
    assumption:
      boundedString(input.assumption, 240) ||
      "Estimated from token_count deltas in local session logs.",
  };
}

function sanitizeWindow(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const id = boundedString(input.id, 40);
  const label = boundedString(input.label, 40);
  if (!id || !label || !/^[a-z0-9_]+$/.test(id)) return null;
  return {
    id,
    label,
    durationSeconds: boundedNumber(input.durationSeconds, 1, 31_536_000),
    usedPercent: boundedNumber(input.usedPercent, 0, 100),
    used: boundedNumber(input.used, 0, Number.MAX_SAFE_INTEGER),
    limit: boundedNumber(input.limit, 0, Number.MAX_SAFE_INTEGER),
    remaining: boundedNumber(input.remaining, 0, Number.MAX_SAFE_INTEGER),
    resetsAt: safeIso(input.resetsAt),
  };
}

function sanitizeProvider(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const id = boundedString(input.id, 20);
  const state = boundedString(input.state, 40);
  if (
    !id ||
    !PROVIDER_ID_PATTERN.test(id) ||
    !state ||
    !PROVIDER_STATES.has(state)
  ) {
    return null;
  }
  const rawWindows = Array.isArray(input.windows) ? input.windows.slice(0, 8) : [];
  const windows = rawWindows
    .map(sanitizeWindow)
    .filter((window): window is NonNullable<typeof window> => Boolean(window));
  const balanceInput =
    input.balance && typeof input.balance === "object"
      ? (input.balance as Record<string, unknown>)
      : null;
  const balanceValue = balanceInput
    ? boundedNumber(balanceInput.value, 0, Number.MAX_SAFE_INTEGER)
    : null;
  const balance =
    balanceInput && balanceValue !== null
      ? {
          label: boundedString(balanceInput.label, 40) || "Balance",
          value: balanceValue,
          unit: boundedString(balanceInput.unit, 20) || "",
        }
      : null;

  return {
    id,
    name: boundedString(input.name, 60) || id,
    shortName: boundedString(input.shortName, 8) || id.slice(0, 2).toUpperCase(),
    accent:
      typeof input.accent === "string" &&
      /^#[0-9a-fA-F]{6}$/.test(input.accent)
        ? input.accent
        : "#7bf1a8",
    state,
    plan: boundedString(input.plan, 80),
    source: boundedString(input.source, 80) || "Remote collector",
    sourceKind: boundedString(input.sourceKind, 40),
    updatedAt: safeIso(input.updatedAt) || new Date().toISOString(),
    windows,
    balance,
    message: boundedString(input.message, 240),
    tokenUsage: sanitizeTokenUsage(input.tokenUsage),
    tokenEstimates: (Array.isArray(input.tokenEstimates)
      ? input.tokenEstimates
      : input.tokenUsage
        ? [input.tokenUsage]
        : []
    )
      .slice(0, 4)
      .map(sanitizeTokenUsage)
      .filter(
        (estimate): estimate is NonNullable<typeof estimate> =>
          Boolean(estimate),
      ),
  };
}

export function sanitizeRemoteSnapshot(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("Snapshot must be an object");
  }
  const input = value as Record<string, unknown>;
  const providers = (Array.isArray(input.providers) ? input.providers : [])
    .slice(0, 16)
    .map(sanitizeProvider)
    .filter(
      (provider): provider is NonNullable<typeof provider> => Boolean(provider),
    );
  if (providers.length === 0) {
    throw new Error("Snapshot has no valid providers");
  }
  const collector =
    input.collector && typeof input.collector === "object"
      ? (input.collector as Record<string, unknown>)
      : {};
  return {
    generatedAt: safeIso(input.generatedAt) || new Date().toISOString(),
    collector: {
      version: boundedString(collector.version, 20) || "unknown",
      state: boundedString(collector.state, 20) || "online",
      startedAt: safeIso(collector.startedAt),
      syncMode: "sanitized-push",
    },
    providers,
  };
}

type RemoteSnapshotRow = {
  id: string;
  payload: string;
  generatedAt: string;
  receivedAt: string;
};

export function mergeRemoteProviderRows(rows: RemoteSnapshotRow[]) {
  const providers = rows
    .filter((row) => PROVIDER_ID_PATTERN.test(row.id))
    .map((row) => {
      try {
        const provider = sanitizeProvider(JSON.parse(row.payload));
        return provider?.id === row.id ? provider : null;
      } catch {
        return null;
      }
    })
    .filter(
      (provider): provider is NonNullable<typeof provider> => Boolean(provider),
    )
    .sort((left, right) => {
      const leftRank = PROVIDER_ORDER.indexOf(left.id);
      const rightRank = PROVIDER_ORDER.indexOf(right.id);
      if (leftRank === -1 && rightRank === -1) {
        return left.name.localeCompare(right.name);
      }
      if (leftRank === -1) return 1;
      if (rightRank === -1) return -1;
      return leftRank - rightRank;
    });

  if (providers.length > 0) {
    const generatedAt = rows
      .filter((row) => PROVIDER_ID_PATTERN.test(row.id))
      .map((row) => safeIso(row.generatedAt))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    return {
      generatedAt: generatedAt || new Date().toISOString(),
      collector: {
        version: pkg.version,
        state: providers.some((provider) => provider.state === "ready")
          ? "online"
          : "attention",
        startedAt: null,
        syncMode: "multi-host-sanitized-push",
      },
      providers,
    };
  }

  const legacy = rows.find((row) => row.id === "latest");
  if (!legacy) return null;
  try {
    return sanitizeRemoteSnapshot(JSON.parse(legacy.payload));
  } catch {
    return null;
  }
}
