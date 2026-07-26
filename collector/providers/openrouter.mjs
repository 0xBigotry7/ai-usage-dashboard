import { hostname } from "node:os";
import {
  fetchJson,
  HUB_VERSION,
  numberOrNull,
  providerError,
  usagePercent,
} from "../shared.mjs";

const OPENROUTER = {
  id: "openrouter",
  name: "OpenRouter",
  shortName: "OR",
  accent: "#d5bcff",
  authMessage: "OpenRouter API Key 不可用，请检查 OPENROUTER_API_KEY。",
};

const DEFAULT_USAGE_URL = "https://openrouter.ai/api/v1/key";

function nextBoundary(reset) {
  const now = new Date();
  if (reset === "daily") {
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
      ),
    ).toISOString();
  }
  if (reset === "weekly") {
    const daysUntilMonday = (8 - now.getUTCDay()) % 7 || 7;
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + daysUntilMonday,
      ),
    ).toISOString();
  }
  if (reset === "monthly") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString();
  }
  return null;
}

export function normalizeOpenRouterUsage(
  payload,
  updatedAt = new Date().toISOString(),
) {
  const data = payload?.data || {};
  const reset = ["daily", "weekly", "monthly"].includes(data.limit_reset)
    ? data.limit_reset
    : "monthly";
  const usedByReset = {
    daily: numberOrNull(data.usage_daily),
    weekly: numberOrNull(data.usage_weekly),
    monthly: numberOrNull(data.usage_monthly),
  };
  const durationByReset = {
    daily: 86_400,
    weekly: 604_800,
    monthly: 2_592_000,
  };
  const labelByReset = {
    daily: "今日",
    weekly: "本周",
    monthly: "本月",
  };
  const idByReset = {
    daily: "daily",
    weekly: "weekly",
    monthly: "monthly",
  };
  const used = usedByReset[reset] ?? numberOrNull(data.usage);
  const limit = numberOrNull(data.limit);
  const remaining =
    numberOrNull(data.limit_remaining) ??
    (limit !== null && used !== null ? Math.max(0, limit - used) : null);

  return {
    id: OPENROUTER.id,
    name: OPENROUTER.name,
    shortName: OPENROUTER.shortName,
    accent: OPENROUTER.accent,
    state: "ready",
    plan: data.is_free_tier ? "Free" : "Usage-based",
    source: "OpenRouter /api/v1/key",
    sourceKind: "api_key",
    host: hostname(),
    updatedAt,
    windows: [
      {
        id: idByReset[reset],
        label: labelByReset[reset],
        durationSeconds: durationByReset[reset],
        usedPercent: usagePercent({ used, limit, remaining }),
        used,
        limit,
        remaining,
        resetsAt: nextBoundary(reset),
      },
    ],
    balance:
      remaining !== null
        ? { label: "Key 剩余额度", value: remaining, unit: "USD" }
        : null,
    message:
      limit === null
        ? "当前 Key 没有设置消费上限；仍显示平台返回的实际消费。"
        : "按当前 API Key 的消费上限与重置周期显示。",
    tokenUsage: null,
    tokenEstimates: [],
  };
}

export async function collectOpenRouterUsage(env = process.env) {
  const updatedAt = new Date().toISOString();
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error("缺少 OPENROUTER_API_KEY");
    error.status = 401;
    return providerError(
      OPENROUTER,
      error,
      "等待 OpenRouter API Key",
      updatedAt,
    );
  }

  try {
    const payload = await fetchJson(DEFAULT_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": `AI-Usage-Dashboard/${HUB_VERSION}`,
      },
    });
    return normalizeOpenRouterUsage(payload, updatedAt);
  } catch (error) {
    return providerError(
      OPENROUTER,
      error,
      "OpenRouter /api/v1/key",
      updatedAt,
    );
  }
}
