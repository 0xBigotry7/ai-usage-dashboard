// Claude Code status-line command. Claude Code pipes its session state to
// this script after each reply; the script keeps only the subscription
// limits, stores them where the collector reads them, and prints a short
// status line.
//
// The snapshot path is resolved exactly as the collector resolves it (private
// env file, then the menu bar connection settings), so the two cannot drift
// apart. An explicit path argument still wins for custom setups.
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { text } from "node:stream/consumers";
import { claudeSubscriptionLimits } from "./claude-quota.mjs";
import { readDesktopPreferences, sourceConfiguration } from "./desktop-preferences.mjs";
import { loadPrivateEnvironment } from "./private-env.mjs";

async function snapshotPath() {
  if (process.argv[2]) return process.argv[2];
  await loadPrivateEnvironment();
  const desktop = await readDesktopPreferences().catch(() => undefined);
  return sourceConfiguration("claude", desktop, process.env).env.USAGE_HUB_CLAUDE_QUOTA_FILE?.trim();
}

const path = await snapshotPath();
if (!path) {
  throw new Error("Set USAGE_HUB_CLAUDE_QUOTA_FILE in ~/.usage-hub/env, or pass the snapshot path");
}

const { rate_limits: reportedLimits } = JSON.parse(await text(process.stdin));
const now = Date.now();
const rateLimits = claudeSubscriptionLimits(reportedLimits, now);
if (Object.keys(rateLimits).length > 0) {
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(staging, JSON.stringify({
      capturedAt: new Date(now).toISOString(),
      rateLimits,
    }), { mode: 0o600, flag: "wx" });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
  const labels = { five_hour: "5h", seven_day: "week" };
  console.log(Object.entries(rateLimits).map(([id, usage]) =>
    `${labels[id]} ${Math.round(100 - usage.used_percentage)}% left`,
  ).join(" · "));
}
