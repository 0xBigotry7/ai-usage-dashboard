import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { readJson } from "../shared.mjs";

const DAY = 86_400_000;
export const MUSE_VALIDATION_ERROR = "Enter a percentage from 0 to 100, a reset date within the next 8 days, and a whole token balance.";
const identity = {
  id: "muse",
  name: "Meta Muse",
  shortName: "MU",
  accent: "#93adff",
  plan: "Personal · Free",
  source: "Manual entry from Muse Usage",
  sourceKind: "manual",
};

export async function readMuseUsage(path) {
  if (!path) return null;
  try {
    const input = await readJson(path);
    return normalizeMuseUsage(input, Date.parse(input.updatedAt), false);
  } catch {
    return null;
  }
}

export function normalizeMuseUsage(input, now = Date.now(), requireActive = true) {
  const remaining = input?.weeklyRemaining;
  const bonusTokens = input?.bonusTokens;
  const resetDate = input?.resetDate;
  const resetDay = /^\d{4}-\d{2}-\d{2}$/.test(resetDate ?? "")
    ? Date.parse(`${resetDate}T00:00:00`)
    : NaN;
  const resetTime = input?.resetsAt ? Date.parse(input.resetsAt) : null;
  const lastValidTime = resetTime ?? (resetDay + DAY);
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100 ||
      !Number.isSafeInteger(bonusTokens) || bonusTokens < 0 ||
      !Number.isFinite(now) || !Number.isFinite(lastValidTime) ||
      (requireActive && (lastValidTime <= now || (resetTime ?? resetDay) > now + 8 * DAY))) {
    throw new Error(MUSE_VALIDATION_ERROR);
  }
  return {
    weeklyRemaining: remaining,
    ...(resetTime === null
      ? { resetDate }
      : { resetsAt: new Date(resetTime).toISOString() }),
    bonusTokens,
    bonusApproximate: input.bonusApproximate === true,
    updatedAt: new Date(now).toISOString(),
  };
}

export async function saveMuseUsage(path, input) {
  const data = normalizeMuseUsage(input);
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

export async function collectMuseUsage(env = process.env) {
  const data = await readMuseUsage(env.USAGE_HUB_MUSE_FILE?.trim());
  const expires = data?.resetsAt
    ? Date.parse(data.resetsAt)
    : Date.parse(`${data?.resetDate}T00:00:00`) + DAY;
  return {
    ...identity,
    host: hostname(),
    updatedAt: data?.updatedAt ?? "",
    state: data ? "ready" : "needs_configuration",
    windows: data ? [{
      id: "weekly",
      label: "Weekly",
      durationSeconds: 604_800,
      usedPercent: Math.round((100 - data.weeklyRemaining) * 100) / 100,
      used: null,
      limit: null,
      remaining: null,
      resetsAt: data.resetsAt ?? null,
      ...(data.resetDate ? { resetDate: data.resetDate } : {}),
    }] : [],
    balance: data ? {
      label: "Referral token balance", value: data.bonusTokens, unit: "tokens",
      approximate: data.bonusApproximate,
    } : null,
    message: !data ? "Enter the figures from your Muse Usage page."
      : expires <= Date.now() ? "This weekly snapshot has expired. Update it from Muse Usage."
      : null,
    tokenUsage: null,
    tokenEstimates: [],
  };
}
