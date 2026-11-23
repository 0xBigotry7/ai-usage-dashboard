import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getClaudeOAuthUsage,
  normalizeClaudeOAuthUsage,
  planLabelFromSubscription,
  readClaudePlanName,
} from "../collector/claude-oauth-usage.mjs";
import { collectClaudeFableUsage } from "../collector/providers/claude-code.mjs";

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
  assert.equal(scoped[0].window.resetsAt, new Date("2031-06-01T12:00:00.123456Z").toISOString());
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
