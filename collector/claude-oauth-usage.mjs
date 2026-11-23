import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
// A token this close to its expiry is treated as expired, so a request is
// never sent with a token that lapses on the way.
const EXPIRY_MARGIN_MS = 60_000;
const RENEWAL_RETRY_MS = 30 * 60_000;
const RENEWAL_TIMEOUT_MS = 60_000;

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

// The endpoint reports the same reset a few milliseconds apart on each call.
// Rounding to the minute keeps it stable for history and alert de-duplication.
function resetTime(value) {
  const iso = toIsoTime(value);
  return iso && new Date(Math.round(Date.parse(iso) / 60_000) * 60_000).toISOString();
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
      resetsAt: resetTime(fiveHour?.resets_at),
    });
  }
  const weekly = payload?.seven_day;
  const weeklyPercent = clampPercent(numberOrNull(weekly?.utilization));
  if (weeklyPercent !== null) {
    windows.push(weeklyWindow("weekly", "Weekly", weeklyPercent, resetTime(weekly?.resets_at)));
  }

  const scoped = [];
  for (const limit of Array.isArray(payload?.limits) ? payload.limits : []) {
    if (limit?.kind !== "weekly_scoped") continue;
    const name = limit?.scope?.model?.display_name;
    const usedPercent = clampPercent(numberOrNull(limit?.percent));
    if (typeof name !== "string" || !name.trim() || usedPercent === null) continue;
    scoped.push({
      model: name.trim(),
      window: weeklyWindow("weekly", "Weekly", usedPercent, resetTime(limit?.resets_at)),
    });
  }
  return { windows, scoped };
}

const readings = new Map();

export function resetClaudeOAuthUsageCache() {
  readings.clear();
  renewal.attemptedAt = -Infinity;
  renewal.pending = null;
}

function isExpired(credentials, now) {
  return Boolean(credentials?.expiresAt) && credentials.expiresAt - EXPIRY_MARGIN_MS <= now;
}

// The collector never uses the refresh token itself: rotating it outside
// Claude Code could sign the CLI out. Claude Code renews its own sign-in
// whenever it sends a request, so the smallest possible request does the job:
// one word to the cheapest model, with tools, customizations and session
// saving switched off. Only the variables Claude Code needs are passed on, so
// keys from the private env file never reach it.
export function renewWithClaudeCode(binary, env) {
  const childEnv = { HOME: homedir(), PATH: env.PATH || "/usr/bin:/bin" };
  for (const key of ["USER", "LOGNAME", "TMPDIR", "LANG", "CLAUDE_CONFIG_DIR"]) {
    if (env[key]?.trim()) childEnv[key] = env[key];
  }
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      [
        "-p", "ok", "--model", "haiku", "--safe-mode", "--strict-mcp-config", "--tools", "",
        "--no-session-persistence", "--system-prompt", "Reply with one word.",
      ],
      { cwd: tmpdir(), env: childEnv, timeout: RENEWAL_TIMEOUT_MS },
      (error) => resolve(!error),
    );
    // Without this Claude Code would wait for a prompt on the open pipe.
    child.stdin?.end();
  });
}

const renewal = { attemptedAt: -Infinity, pending: null };

// One attempt at a time for every card that shares the sign-in, and no more
// than one attempt per retry period however often the cards refresh.
function renewExpiredSignIn(env, now, renew) {
  if (renewal.pending) return renewal.pending;
  const binary = env.USAGE_HUB_CLAUDE_BIN?.trim();
  if (!binary || now - renewal.attemptedAt < RENEWAL_RETRY_MS) return false;
  renewal.attemptedAt = now;
  renewal.pending = Promise.resolve()
    .then(() => renew(binary, env))
    .catch(() => false)
    .finally(() => {
      renewal.pending = null;
    });
  return renewal.pending;
}

async function fetchUsage(credentials, fetchImpl, { now, canRenew }) {
  if (!credentials) {
    return { ok: false, reason: "no_credentials", message: "Claude Code is not signed in on this Mac." };
  }
  if (isExpired(credentials, now)) {
    return {
      ok: false,
      reason: "expired",
      subscriptionType: credentials.subscriptionType,
      message: canRenew
        ? "Claude sign-in could not be renewed automatically. Open Claude Code in a terminal and sign in again if it asks."
        : "Claude sign-in has expired. It renews the next time Claude Code runs in a terminal on this Mac.",
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
export async function getClaudeOAuthUsage(
  env = process.env,
  { fetchImpl = fetch, now = Date.now(), renew = renewWithClaudeCode } = {},
) {
  if (!claudeOAuthUsageEnabled(env)) return null;
  let credentials = await readClaudeOAuthCredentials(env);
  if (isExpired(credentials, now) && await renewExpiredSignIn(env, now, renew)) {
    credentials = await readClaudeOAuthCredentials(env);
  }
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
      result = await fetchUsage(credentials, fetchImpl, {
        now,
        canRenew: Boolean(env.USAGE_HUB_CLAUDE_BIN?.trim()),
      });
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
