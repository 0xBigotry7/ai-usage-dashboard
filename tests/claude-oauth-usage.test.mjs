import assert from "node:assert/strict";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getClaudeOAuthUsage,
  normalizeClaudeOAuthUsage,
  planLabelFromSubscription,
  readClaudePlanName,
  resetClaudeOAuthUsageCache,
} from "../collector/claude-oauth-usage.mjs";
import { collectClaudeCodeUsage, collectClaudeFableUsage } from "../collector/providers/claude-code.mjs";

const HOUR = 3_600_000;

async function claudeProfile(expiresAt, accessToken = "demo-token") {
  const dir = await mkdtemp(join(tmpdir(), "usage-hub-claude-signin-"));
  // Replaced in one step, as a credential store would, so a concurrent reader
  // never sees a half-written file.
  const write = async (token, expiry) => {
    const staging = join(dir, `.credentials.${token}.tmp`);
    await writeFile(staging, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: expiry } }));
    await rename(staging, join(dir, ".credentials.json"));
  };
  await write(accessToken, expiresAt);
  return { dir, write, env: { CLAUDE_CONFIG_DIR: dir, USAGE_HUB_CLAUDE_OAUTH_USAGE: "1" } };
}

const PAYLOAD = {
  five_hour: null,
  seven_day: { utilization: 35, resets_at: "2031-06-01T12:00:00.000000+00:00" },
  limits: [
    { kind: "weekly_all", percent: 35, resets_at: "2031-06-01T12:00:00.000000+00:00", scope: null },
    {
      kind: "weekly_scoped",
      percent: 23,
      resets_at: "2031-06-01T12:00:00.123456+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

test("normalizes the weekly total and the per-model weekly window", () => {
  const { windows, scoped } = normalizeClaudeOAuthUsage(PAYLOAD);
  assert.deepEqual(windows.map((w) => [w.id, w.usedPercent]), [["weekly", 35]]);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].model, "Fable");
  assert.equal(scoped[0].window.usedPercent, 23);
  // Sub-minute jitter in the reported reset is rounded away.
  assert.equal(scoped[0].window.resetsAt, "2031-06-01T12:00:00.000Z");
  const jittered = normalizeClaudeOAuthUsage({ seven_day: { utilization: 1, resets_at: "2031-06-01T11:59:59.911Z" } });
  assert.equal(jittered.windows[0].resetsAt, "2031-06-01T12:00:00.000Z");
});

test("keeps a 5-hour window when the account has one and ignores bad rows", () => {
  const { windows, scoped } = normalizeClaudeOAuthUsage({
    five_hour: { utilization: 40, resets_at: "2031-05-26T12:00:00Z" },
    limits: [{ kind: "weekly_scoped", percent: null, scope: { model: { display_name: "Fable" } } }],
  });
  assert.deepEqual(windows.map((w) => w.id), ["five_hour"]);
  assert.deepEqual(scoped, []);
});

test("stays off, and never reads credentials, unless switched on", async () => {
  let called = false;
  const result = await getClaudeOAuthUsage({}, { fetchImpl: () => { called = true; } });
  assert.equal(result, null);
  assert.equal(called, false);
  const fable = await collectClaudeFableUsage({});
  assert.equal(fable.id, "claude-fable");
  assert.equal(fable.state, "needs_configuration");
  assert.deepEqual(fable.windows, []);
});

test("reads the plan name Claude Code recorded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-hub-claude-plan-"));
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { planDisplayName: "Ultra" } }));
  assert.equal(await readClaudePlanName({ CLAUDE_CONFIG_DIR: dir }), "Ultra");
  const empty = await mkdtemp(join(tmpdir(), "usage-hub-claude-plan-"));
  assert.equal(await readClaudePlanName({ CLAUDE_CONFIG_DIR: empty }), null);
  assert.equal(planLabelFromSubscription("max"), "Max");
  assert.equal(planLabelFromSubscription(null), null);
});

test("isolates cached quota after an account switch in the same selected profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-hub-profile-"));
  const env = { CLAUDE_CONFIG_DIR: dir, USAGE_HUB_CLAUDE_OAUTH_USAGE: "1" };
  let calls = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => ({seven_day: {utilization: ++calls * 20}}) });
  for (const [credential, expected] of [["demo-one", 20], ["demo-one", 20], ["demo-two", 40]]) {
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({claudeAiOauth: {accessToken: credential}}));
    const result = await getClaudeOAuthUsage(env, { fetchImpl });
    assert.equal(result.windows[0].usedPercent, expected);
  }
  assert.equal(calls, 2);
});

test("a status-line fallback keeps its own capture time and says why it is shown", async () => {
  resetClaudeOAuthUsageCache();
  const { dir, env } = await claudeProfile(Date.now() - 25 * HOUR);
  const capturedAt = new Date(Date.now() - 48 * HOUR).toISOString();
  const quotaFile = join(dir, "claude-quota.json");
  await writeFile(quotaFile, JSON.stringify({
    capturedAt,
    rateLimits: { seven_day: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 72 * 3600 } },
  }));

  const claude = await collectClaudeCodeUsage({ ...env, USAGE_HUB_CLAUDE_QUOTA_FILE: quotaFile });
  assert.equal(claude.state, "ready");
  assert.deepEqual(claude.windows.map((w) => [w.id, w.usedPercent]), [["weekly", 10]]);
  // The reading is two days old, so the card must not claim to be current.
  assert.equal(claude.updatedAt, capturedAt);
  assert.equal(claude.source, "Claude Code status line");
  assert.equal(claude.sourceKind, "status_line");
  assert.match(claude.message, /sign-in has expired/);
  assert.match(claude.message, /last status-line reading/);

  const fable = await collectClaudeFableUsage(env);
  assert.equal(fable.state, "auth_error");
  assert.equal(fable.retryable, false);
  assert.deepEqual(fable.windows, []);
});

test("an expired sign-in is renewed by Claude Code before the usage request", async () => {
  resetClaudeOAuthUsageCache();
  const now = Date.parse("2031-01-01T00:00:00Z");
  const { env, write } = await claudeProfile(now - HOUR, "old-token");
  const renewed = [];
  const sent = [];
  const fetchImpl = async (_url, options) => {
    sent.push(options.headers.Authorization);
    return { ok: true, json: async () => ({ seven_day: { utilization: 18 } }) };
  };
  const renew = async (binary) => {
    renewed.push(binary);
    await write("new-token", now + 8 * HOUR);
    return true;
  };
  const withBinary = { ...env, USAGE_HUB_CLAUDE_BIN: "/opt/claude" };

  // Both cards ask at once; the sign-in is renewed once and read once.
  const [first, second] = await Promise.all([
    getClaudeOAuthUsage(withBinary, { fetchImpl, now, renew }),
    getClaudeOAuthUsage(withBinary, { fetchImpl, now, renew }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(first.windows[0].usedPercent, 18);
  assert.equal(second, first);
  assert.deepEqual(renewed, ["/opt/claude"]);
  assert.deepEqual(sent, ["Bearer new-token"]);
});

test("renewal is opt-in, and a failed attempt is not repeated until the retry period ends", async () => {
  resetClaudeOAuthUsageCache();
  const now = Date.parse("2031-01-01T00:00:00Z");
  const { env } = await claudeProfile(now - HOUR);
  let attempts = 0;
  const renew = async () => { attempts += 1; return false; };
  const fetchImpl = async () => { throw new Error("must not be called with an expired token"); };

  const off = await getClaudeOAuthUsage(env, { fetchImpl, now, renew });
  assert.equal(off.reason, "expired");
  assert.match(off.message, /renews the next time Claude Code runs/);
  assert.equal(attempts, 0);

  resetClaudeOAuthUsageCache();
  const on = { ...env, USAGE_HUB_CLAUDE_BIN: "/opt/claude" };
  const failed = await getClaudeOAuthUsage(on, { fetchImpl, now, renew });
  assert.equal(failed.reason, "expired");
  assert.match(failed.message, /could not be renewed automatically/);
  await getClaudeOAuthUsage(on, { fetchImpl, now: now + 10 * 60_000, renew });
  assert.equal(attempts, 1);
  await getClaudeOAuthUsage(on, { fetchImpl, now: now + 31 * 60_000, renew });
  assert.equal(attempts, 2);
});
