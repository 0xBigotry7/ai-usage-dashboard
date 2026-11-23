import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

// agy passes the whole status line payload. Keep only quota data and its tier.
const chunks = [];
let length = 0;
for await (const chunk of process.stdin) {
  length += chunk.length;
  if (length > 262_144) process.exit(1);
  chunks.push(chunk);
}

const state = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (state.product !== "antigravity" || state.agent_state !== "idle" ||
    !state.quota || typeof state.quota !== "object" || Array.isArray(state.quota)) {
  process.exit(0);
}

const windows = Object.entries(state.quota)
  .filter(([id, bucket]) => /^[a-z0-9_-]{1,80}$/i.test(id) && bucket && !bucket.disabled &&
    Number.isFinite(bucket.remaining_fraction) && bucket.remaining_fraction >= 0 && bucket.remaining_fraction <= 1)
  .map(([id, bucket]) => ({
    id,
    remainingFraction: bucket.remaining_fraction,
    resetTime: typeof bucket.reset_time === "string" ? bucket.reset_time.slice(0, 48) : null,
    resetInSeconds: Number.isFinite(bucket.reset_in_seconds) ? bucket.reset_in_seconds : null,
  }));
if (!windows.length) process.exit(0);

const destination = process.argv[2];
const staging = destination + "." + randomUUID() + ".tmp";
const snapshot = {
  plan: typeof state.plan_tier === "string" ? state.plan_tier.slice(0, 80) : null,
  windows,
  capturedAt: new Date().toISOString(),
};
await writeFile(staging, JSON.stringify(snapshot) + "\n", { mode: 0o600, flag: "wx" });
await rename(staging, destination);
