import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampPercent, HUB_VERSION, numberOrNull, toIsoTime } from "./shared.mjs";

// Claude's own plan-usage endpoint: the same data the /usage dialog in Claude
// Code shows. It is a plain GET against the signed-in account and does not
// call a model, so it spends no tokens. Besides the weekly total it lists
// per-model weekly windows (for example Fable) that the status line never
// receives.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CACHE_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 15 * 60_000;

export function claudeOAuthUsageEnabled(env = process.env) {
  return env.USAGE_HUB_CLAUDE_OAUTH_USAGE?.trim() === "1";
}

function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

// Claude Code keeps ~/.claude.json next to the config directory by default,
// and inside CLAUDE_CONFIG_DIR when that is set.
function claudeAccountFile(env) {
  return env.CLAUDE_CONFIG_DIR?.trim()
    ? join(env.CLAUDE_CONFIG_DIR.trim(), ".claude.json")
    : join(homedir(), ".claude.json");
}

const TIER_LABELS = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };

export async function readClaudePlanName(env = process.env) {
  try {
    const account = JSON.parse(await readFile(claudeAccountFile(env), "utf8"))?.oauthAccount;
    const name = account?.planDisplayName;
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    // Fall through: no account file or no plan recorded yet.
  }
  return null;
}

export function planLabelFromSubscription(subscriptionType) {
  if (typeof subscriptionType !== "string") return null;
  return TIER_LABELS[subscriptionType.toLowerCase()] ?? null;
}

function keychainSecret() {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 10_000, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    );
  });
}

// Reads the OAuth access token Claude Code stores (macOS Keychain, or the
// credentials file on other systems). The token is used only for the request
// below and is never logged, cached on disk or returned to callers.
export async function readClaudeOAuthCredentials(env = process.env) {
  let raw = process.platform === "darwin" && !env.CLAUDE_CONFIG_DIR?.trim() ? await keychainSecret() : null;
  if (!raw) {
    try {
      raw = await readFile(join(claudeConfigDir(env), ".credentials.json"), "utf8");
    } catch {
      return null;
    }
  }
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: numberOrNull(oauth.expiresAt),
      subscriptionType: oauth.subscriptionType ?? null,
    };
  } catch {
    return null;
  }
}

function weeklyWindow(id, label, usedPercent, resetsAt) {
  return {
    id,
    label,
    durationSeconds: 604_800,
    usedPercent,
    used: null,
    limit: null,
    remaining: null,
    resetsAt,
  };
}

export function normalizeClaudeOAuthUsage(payload) {
  const windows = [];
  const fiveHour = payload?.five_hour;
  const fivePercent = clampPercent(numberOrNull(fiveHour?.utilization));
  if (fivePercent !== null) {
    windows.push({
      id: "five_hour",
      label: "5-hour",
      durationSeconds: 18_000,
      usedPercent: fivePercent,
      used: null,
      limit: null,
      remaining: null,
      resetsAt: toIsoTime(fiveHour?.resets_at),
    });
  }
  const weekly = payload?.seven_day;
  const weeklyPercent = clampPercent(numberOrNull(weekly?.utilization));
  if (weeklyPercent !== null) {
    windows.push(weeklyWindow("weekly", "Weekly", weeklyPercent, toIsoTime(weekly?.resets_at)));
  }

  const scoped = [];
  for (const limit of Array.isArray(payload?.limits) ? payload.limits : []) {
    if (limit?.kind !== "weekly_scoped") continue;
    const name = limit?.scope?.model?.display_name;
    const usedPercent = clampPercent(numberOrNull(limit?.percent));
    if (typeof name !== "string" || !name.trim() || usedPercent === null) continue;
    scoped.push({
      model: name.trim(),
      window: weeklyWindow("weekly", "Weekly", usedPercent, toIsoTime(limit?.resets_at)),
    });
  }
  return { windows, scoped };
}

const readings = new Map();

export function resetClaudeOAuthUsageCache() {
  readings.clear();
}

async function fetchUsage(credentials, fetchImpl) {
  if (!credentials) {
    return { ok: false, reason: "no_credentials", message: "Claude Code is not signed in on this Mac." };
  }
  if (credentials.expiresAt && credentials.expiresAt <= Date.now()) {
    // Refreshing is left to Claude Code itself; rotating the token here could
    // sign the CLI out.
    return {
      ok: false,
      reason: "expired",
      subscriptionType: credentials.subscriptionType,
      message: "Claude sign-in token expired; it refreshes the next time Claude Code runs.",
    };
  }
  const response = await fetchImpl(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "User-Agent": `AI-Usage-Dashboard/${HUB_VERSION}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    return {
      ok: false,
      reason: `http_${response.status}`,
      subscriptionType: credentials.subscriptionType,
      message: `Claude usage endpoint answered HTTP ${response.status}.`,
    };
  }
  return {
    ok: true,
    subscriptionType: credentials.subscriptionType,
    ...normalizeClaudeOAuthUsage(await response.json()),
  };
}

// Shared by the Claude and Claude-per-model cards: one request per cache
// period no matter how many cards read it.
export async function getClaudeOAuthUsage(env = process.env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!claudeOAuthUsageEnabled(env)) return null;
  const credentials = await readClaudeOAuthCredentials(env);
  const key = createHash("sha256").update(JSON.stringify([claudeConfigDir(env),
    credentials?.accessToken, credentials?.expiresAt])).digest("hex");
  for (const [id, record] of readings) {
    if (!record.pending && record.until <= now) readings.delete(id);
  }
  const previous = readings.get(key);
  if (previous) return previous.pending ?? previous.result;
  const record = {};
  readings.set(key, record);
  record.pending = (async () => {
    let result;
    try {
      result = await fetchUsage(credentials, fetchImpl);
    } catch (error) {
      result = {
        ok: false,
        reason: "network",
        message: `Claude usage endpoint unreachable: ${error?.name === "TimeoutError" ? "timeout" : "network error"}.`,
      };
    }
    result.fetchedAt = new Date().toISOString();
    record.result = result;
    record.until = now + (result.ok || result.reason === "expired" ? CACHE_MS : FAILURE_BACKOFF_MS);
    record.pending = null;
    return result;
  })();
  return record.pending;
}
