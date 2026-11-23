import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clampPercent, providerError, readJson, toIsoTime } from "../shared.mjs";

const ANTIGRAVITY = {
  id: "antigravity", name: "Antigravity", shortName: "AG", accent: "#94b9ff",
  authMessage: "Open agy to finish signing in before the next refresh.",
};
const SOURCE = "Antigravity CLI quota";
const run = promisify(execFile);

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function normalizeWindow(bucket) {
  const id = typeof bucket?.id === "string" ? bucket.id.toLowerCase() : "";
  const kind = id.match(/^([a-z0-9_-]+?)-(weekly|5h|five-hour)$/);
  const remaining = bucket?.remainingFraction;
  if (!kind || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) return null;

  const weekly = kind[2] === "weekly";
  const durationSeconds = weekly ? 604_800 : 18_000;
  const group = {
    gemini: "Gemini models",
    "3p": "Claude and GPT models",
  }[kind[1]] ?? kind[1].split(/[_-]/).map((word) =>
    word ? word[0].toUpperCase() + word.slice(1) : "").join(" ");

  // With a full untouched bucket, agy emits now + duration while /usage says
  // "Quota available". Only show reset information for active windows.
  const resetsAt = remaining < 1 ? toIsoTime(bucket.resetTime) : null;
  return {
    id: id.replaceAll("-", "_"),
    label: `${group} · ${weekly ? "Weekly" : "5 hours"}`,
    durationSeconds, resetsAt,
    usedPercent: clampPercent((1 - remaining) * 100),
    used: null, limit: null, remaining: null,
  };
}

export function normalizeAntigravityUsage(snapshot) {
  const updatedAt = toIsoTime(snapshot?.capturedAt);
  const windows = (Array.isArray(snapshot?.windows) ? snapshot.windows : [])
    .map(normalizeWindow)
    .filter(Boolean)
    .sort((left, right) => left.usedPercent - right.usedPercent);
  if (!updatedAt || !windows.length) throw new Error("agy did not return fresh model group quotas.");
  return {
    id: ANTIGRAVITY.id, name: ANTIGRAVITY.name, shortName: ANTIGRAVITY.shortName,
    accent: ANTIGRAVITY.accent, source: SOURCE, sourceKind: "cli", host: hostname(),
    state: "ready", plan: snapshot.plan ?? null, updatedAt, windows,
    balance: null,
    message: windows.some((window) => !window.resetsAt)
      ? "Fully available windows can have no active reset yet."
      : null,
    tokenUsage: null,
  };
}

export async function collectAntigravityUsage(env = process.env) {
  try {
    const onboarding = await readJson(join(homedir(), ".gemini", "antigravity-cli", "cache", "onboarding.json"))
      .catch(() => null);
    if (!onboarding?.consumerOnboardingComplete && !onboarding?.enterpriseOnboardingComplete &&
        !onboarding?.onboardingComplete) {
      throw Object.assign(new Error("agy setup is incomplete."), { status: 401 });
    }
    const temp = await mkdtemp(join(tmpdir(), "usage-hub-agy-"));
    try {
      const snapshot = join(temp, "quota.json");
      const helper = fileURLToPath(new URL("./agy-statusline.mjs", import.meta.url));
      const script = fileURLToPath(new URL("./agy-usage.exp", import.meta.url));
      const command = [process.execPath, helper, snapshot].map(shellQuote).join(" ");
      const settings = JSON.stringify({ statusLine: { type: "command", command, enabled: true } });
      const workspace = join(homedir(), "Library", "Application Support", "AIUsageDashboard", "agy-workspace");
      await mkdir(workspace, {recursive: true, mode: 0o700});
      const { stdout } = await run("/usr/bin/expect", [script, env.USAGE_HUB_AGY_BIN.trim(), settings, snapshot], {
        cwd: workspace,
        env: { HOME: homedir(), PATH: env.PATH || "/usr/bin:/bin", TERM: "xterm-256color" },
        timeout: 25_000, maxBuffer: 65_536,
      });
      return normalizeAntigravityUsage(JSON.parse(stdout));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } catch (error) {
    const detail = String(error?.stderr ?? "").trim();
    const needsSetup = error?.status === 401 || detail === "AGY_SETUP";
    const failure = needsSetup
      ? Object.assign(new Error("agy sign-in or workspace setup is incomplete."), { status: 401 })
      : new Error("Could not verify a fresh quota response from agy /usage.");
    return providerError(ANTIGRAVITY, failure, SOURCE);
  }
}
