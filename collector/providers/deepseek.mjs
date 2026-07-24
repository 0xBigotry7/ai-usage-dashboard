import { hostname } from "node:os";
import { fetchJson, numberOrNull, providerError } from "../shared.mjs";

const DEEPSEEK = {
  id: "deepseek",
  name: "DeepSeek API",
  shortName: "DS",
  accent: "#78b7ff",
  authMessage: "DeepSeek API Key 不可用，请检查 DEEPSEEK_API_KEY。",
};

const DEFAULT_BALANCE_URL = "https://api.deepseek.com/user/balance";

export function normalizeDeepSeekBalance(
  payload,
  updatedAt = new Date().toISOString(),
) {
  const balances = (payload?.balance_infos || [])
    .map((item) => ({
      currency: String(item?.currency || "").toUpperCase().slice(0, 8),
      total: numberOrNull(item?.total_balance),
    }))
    .filter((item) => item.currency && item.total !== null);
  const primary =
    balances.find((item) => item.currency === "CNY") || balances[0] || null;

  return {
    id: DEEPSEEK.id,
    name: DEEPSEEK.name,
    shortName: DEEPSEEK.shortName,
    accent: DEEPSEEK.accent,
    state: "ready",
    plan: "API Account",
    source: "DeepSeek Balance API",
    sourceKind: "api_key",
    host: hostname(),
    updatedAt,
    windows: [],
    balance: primary
      ? {
          label: `${primary.currency} 可用余额`,
          value: primary.total,
          unit: primary.currency,
        }
      : null,
    message:
      payload?.is_available === false
        ? "账户余额当前不可用于 API 调用。"
        : balances.length > 1
          ? `账户返回 ${balances.map((item) => item.currency).join(" / ")} 多币种余额。`
          : "来自 DeepSeek 官方余额接口。",
    tokenUsage: null,
    tokenEstimates: [],
  };
}

export async function collectDeepSeekBalance(env = process.env) {
  const updatedAt = new Date().toISOString();
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error("缺少 DEEPSEEK_API_KEY");
    error.status = 401;
    return providerError(
      DEEPSEEK,
      error,
      "等待 DeepSeek API Key",
      updatedAt,
    );
  }

  try {
    const payload = await fetchJson(DEFAULT_BALANCE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "AI-Usage-Dashboard/0.6",
      },
    });
    return normalizeDeepSeekBalance(payload, updatedAt);
  } catch (error) {
    return providerError(
      DEEPSEEK,
      error,
      "DeepSeek Balance API",
      updatedAt,
    );
  }
}
