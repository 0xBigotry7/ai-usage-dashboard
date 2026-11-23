import assert from "node:assert/strict";
import test from "node:test";
import {
  collectOpenCodeGoUsage,
  normalizeOpenCodeGoUsage,
} from "../collector/providers/opencode-go.mjs";

test("normalizes the three shared OpenCode Go meters", () => {
  const result = normalizeOpenCodeGoUsage({
    usage: {
      rolling: { status: "ok", percent: 20, resetsAt: "2030-02-03T12:00:00.000Z" },
      weekly: { status: "ok", percent: 35, resetsAt: "2030-02-04T00:00:00.000Z" },
      monthly: { status: "ok", percent: 60, resetsAt: "2030-03-01T00:00:00.000Z" },
    },
  });

  assert.equal(result.state, "ready");
  assert.deepEqual(result.windows.map((w) => w.id), ["five_hour", "weekly", "monthly"]);
  assert.deepEqual(result.windows.map((w) => w.usedPercent), [20, 35, 60]);
  assert.equal(result.windows[1].resetsAt, "2030-02-04T00:00:00.000Z");
  assert.equal(result.balance, null);
});

test("accepts an unwrapped payload and flags a reached limit", () => {
  const result = normalizeOpenCodeGoUsage({
    rolling: { status: "limited", percent: 100, resetsAt: "2030-02-03T12:00:00.000Z" },
  });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].usedPercent, 100);
  assert.match(result.message, /Limit reached: 5-hour/);
});

test("does not invent meters from an empty payload", () => {
  const result = normalizeOpenCodeGoUsage({ usage: {} });
  assert.equal(result.windows.length, 0);
  assert.match(result.message, /no usage meters/);
});

test("asks for configuration without a key", async () => {
  const result = await collectOpenCodeGoUsage({});
  assert.equal(result.state, "needs_configuration");
  assert.deepEqual(result.windows, []);
});
