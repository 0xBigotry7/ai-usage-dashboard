import { hostname } from "node:os";
import {
  fetchJson,
  HUB_VERSION,
  numberOrNull,
  providerError,
} from "../shared.mjs";

const DEEPSEEK = {
  id: "deepseek",
  name: "DeepSeek API",
  shortName: "DS",
  accent: "#78b7ff",
  authMessage: "DeepSeek API key is not usable. Check DEEPSEEK_API_KEY.",
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
          label: `Available balance (${primary.currency})`,
          value: primary.total,
          unit: primary.currency,
        }
      : null,
    message:
      payload?.is_available === false
        ? "Account balance is currently not usable for API calls."
        : balances.length > 1
          ? `Account returned balances in multiple currencies: ${balances.map((item) => item.currency).join(" / ")}.`
          : "From DeepSeek's official balance API.",
    tokenUsage: null,
    tokenEstimates: [],
  };
}

export async function collectDeepSeekBalance(env = process.env) {
  const updatedAt = new Date().toISOString();
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error("Missing DEEPSEEK_API_KEY");
    error.status = 401;
    const result = providerError(
      DEEPSEEK,
      error,
      "Waiting for DeepSeek API Key",
      updatedAt,
    );
    result.state = "needs_configuration";
    result.tokenUsage = null;
    return result;
  }

  try {
    const payload = await fetchJson(DEFAULT_BALANCE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": `AI-Usage-Dashboard/${HUB_VERSION}`,
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
