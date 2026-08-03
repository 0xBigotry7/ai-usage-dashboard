import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  durationToWindow,
  fetchJson,
  HUB_VERSION,
  numberOrNull,
  providerError,
  readJson,
  toIsoTime,
  usagePercent,
} from "../shared.mjs";
import { estimateWeeklyQuotaTokens } from "../quota-estimate.mjs";

const KIMI = {
  id: "kimi",
  name: "Kimi Code",
  shortName: "KM",
  accent: "#b7c8ff",
  authMessage: "Kimi Code 凭证不可用，请配置长期 KIMI_CODE_API_KEY。",
};

const DEFAULT_BASE_URL = "https://api.kimi.com";

const SECONDS_BY_TIME_UNIT = new Map([
  ["SECOND", 1],
  ["MINUTE", 60],
  ["HOUR", 3600],
  ["DAY", 86_400],
  ["WEEK", 604_800],
  ["MONTH", 2_592_000],
]);
const warnedUnknownTimeUnits = new Set();

function durationInSeconds(window) {
  const duration = Number(window?.duration);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const unit = String(window?.timeUnit || "").toUpperCase();
  const normalized = unit.startsWith("TIME_UNIT_")
    ? unit.slice("TIME_UNIT_".length)
    : unit;
  // Exact matching only: substring checks would misread e.g.
  // TIME_UNIT_MILLISECOND as seconds (a 1000x error).
  const secondsPerUnit = SECONDS_BY_TIME_UNIT.get(normalized);
  if (!secondsPerUnit) {
    if (!warnedUnknownTimeUnits.has(unit)) {
      warnedUnknownTimeUnits.add(unit);
      console.warn(
        `Kimi usage API returned unrecognized time unit "${window?.timeUnit}"; skipping that quota window.`,
      );
    }
    return null;
  }
  return duration * secondsPerUnit;
}

function normalizeDetail(detail, descriptor) {
  const used = numberOrNull(detail?.used);
  const limit = numberOrNull(detail?.limit);
  const remaining = numberOrNull(detail?.remaining);
  return {
    ...descriptor,
    usedPercent: usagePercent({ used, limit, remaining }),
    used,
    limit,
    remaining,
    resetsAt: toIsoTime(detail?.resetTime ?? detail?.reset_time ?? detail?.resetAt),
  };
}

export function normalizeKimiUsage(
  payload,
  { updatedAt = new Date().toISOString(), source = "Kimi Code API Key", sourceKind = "api_key" } = {},
) {
  const windows = [];
  if (payload?.usage) {
    windows.push(
      normalizeDetail(payload.usage, {
        id: "weekly",
        label: "本周",
        durationSeconds: 604_800,
      }),
    );
  }

  for (const limit of payload?.limits || []) {
    const durationSeconds = durationInSeconds(limit.window);
    if (!durationSeconds || !limit?.detail) continue;
    windows.push(
      normalizeDetail(limit.detail, durationToWindow(durationSeconds)),
    );
  }

  const uniqueWindows = [
    ...new Map(windows.map((window) => [window.id, window])).values(),
  ].sort((a, b) => a.durationSeconds - b.durationSeconds);

  return {
    id: KIMI.id,
    name: KIMI.name,
    shortName: KIMI.shortName,
    accent: KIMI.accent,
    state: "ready",
    plan: "Kimi Code",
    source,
    sourceKind,
    host: hostname(),
    updatedAt,
    windows: uniqueWindows,
    balance: null,
    message:
      sourceKind === "cli_session"
        ? "当前使用 Kimi CLI 的短期登录态；配置长期 API Key 后会自动切换。"
        : null,
  };
}

async function readCliCredential(env) {
  const kimiHome = env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
  try {
    const credential = await readJson(
      join(kimiHome, "credentials", "kimi-code.json"),
    );
    const expiresAt = Number(credential?.expires_at);
    if (
      !credential?.access_token ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() / 1000 + 60
    ) {
      return null;
    }
    return credential.access_token;
  } catch {
    return null;
  }
}

async function readDeviceId(env) {
  const kimiHome = env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
  try {
    return (await readFile(join(kimiHome, "device_id"), "utf8")).trim();
  } catch {
    return null;
  }
}

export async function collectKimiUsage(env = process.env) {
  const updatedAt = new Date().toISOString();
  const apiKey = env.KIMI_CODE_API_KEY?.trim();
  const cliToken = apiKey ? null : await readCliCredential(env);
  const token = apiKey || cliToken;
  const source = apiKey ? "Kimi Code API Key" : "Kimi CLI 临时登录";
  const sourceKind = apiKey ? "api_key" : "cli_session";

  if (!token) {
    const error = new Error("缺少长期 Kimi Code API Key");
    error.status = 401;
    const result = providerError(KIMI, error, "等待 Kimi Code API Key", updatedAt);
    result.state = "needs_configuration";
    result.tokenUsage = null;
    return result;
  }

  try {
    const rawBase = env.KIMI_CODE_BASE_URL || DEFAULT_BASE_URL;
    const base = new URL(rawBase);
    if (base.protocol !== "https:" || base.username || base.password) {
      throw new Error("KIMI_CODE_BASE_URL 必须是安全的 HTTPS 地址");
    }
    const basePath = base.pathname.replace(/\/+$/, "");
    const normalizedBase = base.href.replace(/\/+$/, "");
    const endpoint = basePath.endsWith("/coding/v1")
      ? new URL(`${normalizedBase}/usages`)
      : basePath.endsWith("/coding")
        ? new URL(`${normalizedBase}/v1/usages`)
        : new URL(`${normalizedBase}/coding/v1/usages`);
    const deviceId = await readDeviceId(env);

    const payload = await fetchJson(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": `AI-Usage-Dashboard/${HUB_VERSION}`,
        "X-Msh-Platform": "kimi_code_cli",
        ...(deviceId ? { "X-Msh-Device-Id": deviceId } : {}),
      },
    });
    const provider = normalizeKimiUsage(payload, {
      updatedAt,
      source,
      sourceKind,
    });
    const quotaEstimate = estimateWeeklyQuotaTokens(provider.windows, {
      id: "kimi-code-subscription",
      label: "Kimi Code 综合订阅",
      capacityTokens: env.USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY,
    });
    provider.tokenUsage = quotaEstimate;
    provider.tokenEstimates = quotaEstimate ? [quotaEstimate] : [];
    return provider;
  } catch (error) {
    return {
      ...providerError(KIMI, error, source, updatedAt),
      tokenUsage: null,
      tokenEstimates: [],
    };
  }
}
