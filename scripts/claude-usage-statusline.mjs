import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { claudeSubscriptionLimits } from "../collector/claude-quota.mjs";

const path = process.argv[2];
if (!path) throw new Error("Missing Claude quota snapshot path");

const { rate_limits: reportedLimits } = JSON.parse(await text(process.stdin));
const now = Date.now();
const rateLimits = claudeSubscriptionLimits(reportedLimits, now);
if (Object.keys(rateLimits).length > 0) {
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
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
