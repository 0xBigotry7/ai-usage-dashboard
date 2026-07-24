import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  clampPercent,
  durationToWindow,
  fetchJson,
  providerError,
  readJson,
  toIsoTime,
} from "../shared.mjs";
import { estimateWeeklyQuotaTokens } from "../quota-estimate.mjs";
import { estimateCodexSessionLogTokens } from "../session-log-estimate.mjs";

const CODEX = {
  id: "codex",
  name: "OpenAI Codex",
  shortName: "CX",
  accent: "#7bf1a8",
  authMessage: "Codex 登录已失效，请在这台 Mac 上运行 codex 重新登录。",
};

const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function formatPlan(plan) {
  if (!plan) return null;
  if (plan === "prolite") return "Pro Lite";
  return String(plan)
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function normalizeCodexUsage(payload, updatedAt = new Date().toISOString()) {
  const rawWindows = [
    payload?.rate_limit?.primary_window,
    payload?.rate_limit?.secondary_window,
  ].filter(Boolean);

  const windows = rawWindows
    .map((window) => {
      const durationSeconds = Number(window.limit_window_seconds);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
      const descriptor = durationToWindow(durationSeconds);
      return {
        ...descriptor,
        usedPercent: clampPercent(Number(window.used_percent)),
        used: null,
        limit: null,
        remaining: null,
        resetsAt: toIsoTime(window.reset_at),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.durationSeconds - b.durationSeconds);

  const balanceNumber = Number(payload?.credits?.balance);
  const hasBalance = Number.isFinite(balanceNumber);

  return {
    id: CODEX.id,
    name: CODEX.name,
    shortName: CODEX.shortName,
    accent: CODEX.accent,
    state: "ready",
    plan: formatPlan(payload?.plan_type),
    source: "本机 Codex OAuth",
    sourceKind: "oauth",
    host: hostname(),
    updatedAt,
    windows,
    balance: hasBalance
      ? { label: "可用积分", value: balanceNumber, unit: "credits" }
      : null,
    message:
      windows.length === 0
        ? "OpenAI 当前没有返回可显示的配额窗口。"
        : null,
  };
}

export async function collectCodexUsage(env = process.env) {
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  const authPath = join(codexHome, "auth.json");
  const updatedAt = new Date().toISOString();
  let logEstimate = null;
  try {
    logEstimate = await estimateCodexSessionLogTokens(env);
  } catch {
    // Quota collection should continue if local logs are unavailable.
  }

  try {
    const auth = await readJson(authPath);
    const accessToken = auth?.tokens?.access_token;
    const accountId = auth?.tokens?.account_id;
    if (!accessToken) {
      const error = new Error("本机没有可用的 Codex 登录");
      error.status = 401;
      throw error;
    }

    const payload = await fetchJson(env.CODEX_USAGE_URL || DEFAULT_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "AI-Usage-Dashboard/0.5",
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      },
    });
    const provider = normalizeCodexUsage(payload, updatedAt);
    const quotaEstimate = estimateWeeklyQuotaTokens(provider.windows, {
      id: "codex-subscription",
      label: "Codex 综合订阅",
      capacityTokens: env.USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY,
    });
    provider.tokenUsage = quotaEstimate;
    provider.tokenEstimates = [quotaEstimate, logEstimate].filter(Boolean);
    return provider;
  } catch (error) {
    if (error?.code === "ENOENT") {
      error.status = 401;
    }
    return {
      ...providerError(CODEX, error, "本机 Codex OAuth", updatedAt),
      tokenUsage: null,
      tokenEstimates: logEstimate ? [logEstimate] : [],
    };
  }
}
