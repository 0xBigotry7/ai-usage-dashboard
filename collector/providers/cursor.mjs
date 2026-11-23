import { DatabaseSync } from "node:sqlite";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { decodeJwtPayload } from "../jwt.mjs";
import { fetchJson, numberOrNull, providerError, toIsoTime } from "../shared.mjs";

const CURSOR = {
  id: "cursor", name: "Cursor", shortName: "CU", accent: "#cbd5e1",
  authMessage: "Open Cursor and sign in again to resume usage updates.",
};
const GROK_BOT = {
  id: "grok-bot", name: "Grok Bot", shortName: "GB", accent: "#d7d9e0",
  authMessage: "Sign in to the Cursor account linked to Grok Bot.",
};

// Newer Cursor builds encrypt the saved sign-in on disk. That protection is
// Cursor's to keep, so the reader stops here instead of trying to undo it.
const ENCRYPTED_AT_REST =
  "Cursor now keeps its sign-in encrypted on this Mac, so usage can no longer be read from the desktop app.";

// Read the current desktop access token only. The application manages login
// and renewal. This collector never persists credentials or follows redirects.
function readCursorSession(env) {
  const path = env.USAGE_HUB_CURSOR_DB?.trim()
    || join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  const signedOut = () => Object.assign(new Error("Cursor desktop sign-in is unavailable."), { status: 401 });
  let value;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
    value = row?.value == null ? "" : Buffer.from(row.value).toString("utf8").trim();
    if (value.startsWith('"')) value = JSON.parse(value);
  } catch {
    throw signedOut();
  } finally {
    db?.close();
  }
  if (!value) throw signedOut();
  const token = value.split("::").at(-1);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw Object.assign(new Error(ENCRYPTED_AT_REST), { unreadable: true });
  }
  const claims = decodeJwtPayload(token);
  const account = claims?.sub?.split("|").at(-1);
  if (!/^[A-Za-z0-9_-]+$/.test(account ?? "") ||
      !Number.isFinite(claims?.exp) || claims.exp * 1_000 <= Date.now()) throw signedOut();
  return { token, account };
}

// A sign-in this reader cannot use will not start working on a retry.
function failure(identity, error, source, hint = "") {
  const result = providerError(identity, error, source);
  return error?.unreadable
    ? { ...result, message: `${result.message}${hint}`, retryable: false }
    : result;
}

function percent(input) {
  if (typeof input !== "number" && (typeof input !== "string" || !input.trim())) return null;
  const value = numberOrNull(input);
  return value !== null && value >= 0 && value <= 100 ? value : null;
}

function quota(id, label, usedPercent, resetsAt = null, durationSeconds = null) {
  return { id, label, usedPercent, resetsAt, durationSeconds, used: null, limit: null, remaining: null };
}

function provider(identity, source, plan, windows, usageDetails, message, balance = null) {
  return {
    id: identity.id, name: identity.name, shortName: identity.shortName, accent: identity.accent,
    source, plan, windows, usageDetails, message, balance,
    state: "ready", sourceKind: "desktop_session", host: hostname(),
    updatedAt: new Date().toISOString(), tokenUsage: null,
  };
}

function planName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9 +_-]{1,40}$/.test(value)) return null;
  return value.replace(/(^|\s)[a-z]/g, (character) => character.toUpperCase());
}

function dateLabel(value) {
  const date = toIsoTime(value);
  return date && new Date(date).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function normalizeCursorUsage(data) {
  const individual = data?.individualUsage;
  const included = individual?.plan;
  const windows = [
    quota("auto", "Auto model usage", percent(included?.autoPercentUsed)),
    quota("named_models", "Named model usage", percent(included?.apiPercentUsed)),
    quota("included", "Included usage", percent(included?.totalPercentUsed)),
  ].filter((window) => window.usedPercent !== null);
  if (!windows.length) throw new Error("Cursor did not return usable personal usage figures.");

  const cycleEnd = dateLabel(data.billingCycleEnd);
  const onDemand = individual.onDemand;
  const usageDetails = [];
  if (cycleEnd) usageDetails.push({ label: "Billing period ends", value: cycleEnd });
  if (typeof onDemand?.enabled === "boolean") {
    usageDetails.push({ label: "On-demand usage", value: onDemand.enabled ? "Enabled" : "Off" });
  }
  return provider(CURSOR, "Cursor desktop account", planName(data.membershipType), windows,
    usageDetails, "Auto and named model percentages describe the Cursor billing cycle.");
}

function botUsageDetails(data, breakdown) {
  const result = [];
  const additional = data.additionalUsageLimit;
  if (additional?.state === "STATE_NONE") result.push({ label: "Additional usage cap", value: "No cap reported" });
  const spent = numberOrNull(additional?.spentCents);
  if (spent !== null && spent >= 0) {
    result.push({ label: "Additional usage spent", value: `$${(spent / 100).toFixed(2)}` });
  }
  if (data.hasAvailableUsage === true) result.push({ label: "Bot availability", value: "Available" });
  const weekly = breakdown?.weeklyLimitPpm;
  const breakdownEnd = toIsoTime(numberOrNull(weekly?.periodEndMs));
  if (weekly && breakdownEnd === toIsoTime(data.nextResetTimestampUtc)) {
    const bySource = new Map();
    for (const row of Array.isArray(weekly.bySource) ? weekly.bySource : []) {
      const source = typeof row?.source === "string"
        ? row.source.match(/^GROK_BOT_USAGE_SOURCE_([A-Z_]+)$/)?.[1] : null;
      const ppm = numberOrNull(row?.ppm);
      if (source && ppm !== null && ppm > 0) bySource.set(source, (bySource.get(source) || 0) + ppm);
    }
    for (const [source, ppm] of [...bySource].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
      result.push({ label: `Weekly usage · ${source.toLowerCase().replaceAll("_", " ")}`,
        value: `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(ppm / 10_000)}%` });
    }
  }
  return result;
}

export function normalizeGrokBotUsage(data, breakdown) {
  const used = percent(data?.usagePercent);
  const reset = toIsoTime(data?.nextResetTimestampUtc);
  const start = toIsoTime(data?.currentPeriodStart);
  if (data?.hasNonZeroIncludedLimit === false || used === null || !reset) {
    throw new Error("Grok Bot did not return an included allowance and reset time.");
  }
  const period = start ? (Date.parse(reset) - Date.parse(start)) / 1_000 : 0;
  const duration = period > 0 ? Math.round(period) : null;
  const prepaid = numberOrNull(data.prepaidAvailableCents);
  const message = data.isUnified === true
    ? "Uses the linked Grok weekly pool. See Grok for the shared account total."
    : "Allowance reported by the linked Cursor account.";
  return {
    ...provider(GROK_BOT, "Grok Bot billing", planName(data.grokPlanLabel) ?? planName(data.cursorPlanName),
      [quota("weekly", "Weekly", used, reset, duration)], botUsageDetails(data, breakdown), message,
      prepaid !== null && prepaid >= 0
        ? { label: data.isUnified === true ? "Shared prepaid credits" : "Prepaid credits", value: prepaid / 100, unit: "USD" }
        : null),
    sharedWeekStart: data.isUnified === true ? start : null,
  };
}

export async function collectCursorUsage(env = process.env) {
  try {
    const { token, account } = readCursorSession(env);
    const data = await fetchJson("https://cursor.com/api/usage-summary", {
      redirect: "error",
      headers: {
        Accept: "application/json",
        Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${account}::${token}`)}`,
        Origin: "https://cursor.com",
      },
    }, 10_000);
    return { ...normalizeCursorUsage(data), cursorAccount: account };
  } catch (error) {
    return failure(CURSOR, error, "Cursor desktop account");
  }
}

function fetchBotBilling(method, token) {
  return fetchJson(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      Authorization: `Bearer ${token}`,
    },
    body: "{}",
  }, 10_000);
}

export async function collectGrokBotUsage(env = process.env) {
  try {
    const { token, account } = readCursorSession(env);
    const [usage, breakdown] = await Promise.all([
      fetchBotBilling("GetSandUsageStatus", token),
      fetchBotBilling("GetGrokBotUsageBreakdown", token).catch(() => null),
    ]);
    return { ...normalizeGrokBotUsage(usage, breakdown), cursorAccount: account };
  } catch (error) {
    return failure(GROK_BOT, error, "Grok Bot billing",
      " When Grok Bot draws on the shared Grok weekly allowance, the Grok card still counts its usage.");
  }
}
