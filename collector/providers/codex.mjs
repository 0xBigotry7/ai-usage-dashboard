import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  clampPercent,
  durationToWindow,
  fetchJson,
  HUB_VERSION,
  providerError,
  readJson,
  toIsoTime,
} from "../shared.mjs";
import { estimateWeeklyQuotaTokens } from "../quota-estimate.mjs";
import { estimateCodexSessionLogTokenEstimates } from "../session-log-estimate.mjs";
import { describeDurationAgo, jwtExpiresAtMs } from "../jwt.mjs";

const CODEX = {
  id: "codex",
  name: "OpenAI Codex",
  shortName: "CX",
  accent: "#7bf1a8",
  authMessage: "Codex sign-in has expired. Run codex on this machine to sign in again.",
};

const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

// Tolerate modest clock drift before declaring a stored login expired.
const EXPIRY_CLOCK_SKEW_MS = 60_000;

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
    source: "Local Codex OAuth",
    sourceKind: "oauth",
    host: hostname(),
    updatedAt,
    windows,
    balance: hasBalance
      ? { label: "Available credits", value: balanceNumber, unit: "credits" }
      : null,
    message:
      windows.length === 0
        ? "OpenAI did not return any quota windows to display."
        : null,
  };
}

export async function collectCodexUsage(env = process.env) {
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  const authPath = join(codexHome, "auth.json");
  const updatedAt = new Date().toISOString();
  let logEstimates = [];
  try {
    logEstimates = await estimateCodexSessionLogTokenEstimates(env);
  } catch (error) {
    // Quota collection should continue if local logs are unavailable.
    console.warn(
      `Codex session-log token estimate failed: ${error?.message || error}`,
    );
  }

  try {
    const auth = await readJson(authPath);
    const accessToken = auth?.tokens?.access_token;
    const accountId = auth?.tokens?.account_id;
    if (!accessToken) {
      const error = new Error("No usable Codex sign-in on this machine");
      error.status = 401;
      throw error;
    }

    // The access token is a JWT; decode its exp locally so an expired login
    // gets a precise, actionable message instead of a doomed network call.
    // Deliberately no auto-refresh: Codex refresh tokens are single-use
    // (rotating), so refreshing outside the CLI would invalidate the CLI's
    // stored session (see collector/jwt.mjs and docs/security.md).
    const expiresAtMs = jwtExpiresAtMs(accessToken);
    if (expiresAtMs !== null && expiresAtMs + EXPIRY_CLOCK_SKEW_MS < Date.now()) {
      const ago = describeDurationAgo(Date.now() - expiresAtMs);
      const error = new Error(`Codex login expired ${ago}`);
      error.status = 401;
      error.authMessage =
        `Codex login expired ${ago} — run any codex command on this machine to re-login.`;
      throw error;
    }

    const payload = await fetchJson(env.CODEX_USAGE_URL || DEFAULT_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": `AI-Usage-Dashboard/${HUB_VERSION}`,
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      },
    });
    const provider = normalizeCodexUsage(payload, updatedAt);
    const quotaEstimate = estimateWeeklyQuotaTokens(provider.windows, {
      id: "codex-subscription",
      label: "Codex subscription (combined)",
      capacityTokens: env.USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY,
    });
    provider.tokenUsage =
      logEstimates.find((estimate) => estimate.periodId === "today") ||
      quotaEstimate;
    provider.tokenEstimates = [...logEstimates, quotaEstimate].filter(Boolean);
    return provider;
  } catch (error) {
    if (error?.code === "ENOENT") {
      error.status = 401;
    }
    const descriptor =
      typeof error?.authMessage === "string" && error.authMessage
        ? { ...CODEX, authMessage: error.authMessage }
        : CODEX;
    return {
      ...providerError(descriptor, error, "Local Codex OAuth", updatedAt),
      tokenUsage:
        logEstimates.find((estimate) => estimate.periodId === "today") ||
        logEstimates[0] ||
        null,
      tokenEstimates: logEstimates,
    };
  }
}
