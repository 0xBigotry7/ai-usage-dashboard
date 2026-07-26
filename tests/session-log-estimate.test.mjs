import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { estimateWeeklyQuotaTokens } from "../collector/quota-estimate.mjs";
import {
  estimateCodexSessionLogTokens,
  summarizeTokenCountRecords,
} from "../collector/session-log-estimate.mjs";

const DAY_MS = 86_400_000;
const WEEK_SECONDS = 604_800;

test("sums counter deltas and only falls back to last turn on counter reset", () => {
  const result = summarizeTokenCountRecords(
    [
      {
        sessionId: "session-a",
        timestamp: 1_000,
        totalTokens: 100,
        model: "gpt-example",
      },
      {
        sessionId: "session-a",
        timestamp: 2_000,
        totalTokens: 190,
        lastTokens: 80,
        model: "gpt-example",
      },
      {
        sessionId: "session-a",
        timestamp: 3_000,
        totalTokens: 250,
        lastTokens: 60,
        model: "gpt-example",
      },
      {
        sessionId: "session-a",
        timestamp: 4_000,
        totalTokens: 30,
        lastTokens: 25,
        model: "gpt-example",
      },
    ],
    0,
  );

  // 100 (first event) + 90 (counter delta, not the 80 of the last turn)
  // + 60 (delta) + 25 (counter reset: delta <= 0, last-turn fallback).
  assert.equal(result.totalTokens, 275);
  assert.equal(result.sessionCount, 1);
  assert.deepEqual(
    result.models.map((model) => [model.label, model.estimatedTokens]),
    [["gpt-example", 275]],
  );
});

test("counts only the last turn for resume/fork files that inherit the parent counter", () => {
  const result = summarizeTokenCountRecords(
    [
      {
        sessionId: "rollout-parent",
        timestamp: 1_000,
        totalTokens: 500,
        lastTokens: 500,
        model: "gpt-example",
      },
      {
        sessionId: "rollout-parent",
        timestamp: 2_000,
        totalTokens: 650,
        lastTokens: 150,
        model: "gpt-example",
      },
      {
        sessionId: "rollout-fork",
        timestamp: 3_000,
        totalTokens: 195_573_881,
        lastTokens: 128_017,
        model: "gpt-example",
      },
      {
        sessionId: "rollout-fork",
        timestamp: 4_000,
        totalTokens: 195_578_881,
        lastTokens: 5_000,
        model: "gpt-example",
      },
    ],
    0,
  );

  // Parent: 500 + 150. Fork: 128,017 (only the new turn, not the inherited
  // 195M counter) + 5,000 delta.
  assert.equal(result.totalTokens, 133_667);
  assert.equal(result.sessionCount, 2);
});

test("tracks cached input tokens with the same counter-delta method", () => {
  const result = summarizeTokenCountRecords(
    [
      {
        sessionId: "session-c",
        timestamp: 1_000,
        totalTokens: 1_000,
        lastTokens: 1_000,
        cachedTokens: 800,
        cachedLastTokens: 800,
        model: "gpt-example",
      },
      {
        sessionId: "session-c",
        timestamp: 2_000,
        totalTokens: 1_500,
        lastTokens: 500,
        cachedTokens: 1_200,
        cachedLastTokens: 400,
        model: "gpt-example",
      },
      {
        sessionId: "session-c",
        timestamp: 3_000,
        totalTokens: 1_500,
        lastTokens: 0,
        cachedTokens: 1_250,
        cachedLastTokens: 50,
        model: "gpt-example",
      },
      {
        sessionId: "session-d-fork",
        timestamp: 4_000,
        totalTokens: 9_000,
        lastTokens: 300,
        cachedTokens: 6_000,
        cachedLastTokens: 120,
        model: "gpt-example-mini",
      },
      {
        sessionId: "session-d-fork",
        timestamp: 5_000,
        totalTokens: 9_300,
        lastTokens: 300,
        cachedTokens: 6_150,
        cachedLastTokens: 150,
        model: "gpt-example-mini",
      },
    ],
    0,
  );

  // session-c: 1000 + 500 + 0 total, 800 + 400 + 50 cached.
  // session-d-fork (inherited counter): 300 + 300 total, 120 + 150 cached.
  assert.equal(result.totalTokens, 2_100);
  assert.equal(result.cachedInputTokens, 1_520);
  assert.deepEqual(
    result.models.map((model) => [
      model.label,
      model.estimatedTokens,
      model.cachedInputTokens,
    ]),
    [
      ["gpt-example", 1_500, 1_250],
      ["gpt-example-mini", 600, 270],
    ],
  );
});

function tokenCountLine(
  timestamp,
  { total, last, cached, cachedLast, secondary } = {},
) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 0,
          cached_input_tokens: cached ?? 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: total,
        },
        last_token_usage:
          last === undefined
            ? undefined
            : {
                input_tokens: 0,
                cached_input_tokens: cachedLast ?? 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: last,
              },
      },
      ...(secondary ? { rate_limits: { secondary } } : {}),
    },
  });
}

async function withSessionDir(files, run) {
  const directory = await mkdtemp(join(tmpdir(), "usage-hub-logs-"));
  try {
    const sessionsDir = join(directory, "sessions", "2026", "07");
    await mkdir(sessionsDir, { recursive: true });
    for (const [name, lines] of Object.entries(files)) {
      await writeFile(join(sessionsDir, name), `${lines.join("\n")}\n`);
    }
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("aligns the log window with the quota cycle from rate_limits.secondary", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const resetsAtSec = now / 1000 + 3 * 86_400;
  const secondary = {
    used_percent: 19,
    window_minutes: 10_080,
    resets_at: resetsAtSec,
  };
  const oldTimestamp = new Date(now - 6 * DAY_MS).toISOString();
  const recentTimestamp = new Date(now - 1 * DAY_MS).toISOString();
  // Same event as tokenCountLine(recentTimestamp, ...) but written with
  // whitespace around colons, which the line pre-filter must tolerate.
  const spacedRecentLine =
    `{ "timestamp": "${recentTimestamp}", "type": "event_msg", ` +
    `"payload": { "type": "token_count", "info": { ` +
    `"total_token_usage": { "total_tokens": 1600, "cached_input_tokens": 900 }, ` +
    `"last_token_usage": { "total_tokens": 600, "cached_input_tokens": 200 } }, ` +
    `"rate_limits": { "secondary": { "window_minutes": 10080, "resets_at": ${resetsAtSec} } } } }`;

  const result = await withSessionDir(
    {
      "rollout-aligned.jsonl": [
        tokenCountLine(oldTimestamp, {
          total: 1_000,
          last: 1_000,
          cached: 700,
          cachedLast: 700,
          secondary,
        }),
        spacedRecentLine,
        JSON.stringify({
          timestamp: recentTimestamp,
          type: "event_msg",
          payload: { type: "user_message", message: "not a token event" },
        }),
        `{broken "type":"token_count"`,
      ],
    },
    (codexHome) =>
      estimateCodexSessionLogTokens({ CODEX_HOME: codexHome }, now),
  );

  // Window is [resets_at - 10080min, resets_at] = [now-4d, now+3d], so the
  // now-6d event is out of window and only its delta base matters.
  assert.equal(result.basis, "session_logs");
  assert.equal(result.estimated, true);
  assert.equal(result.totalTokens, 600);
  assert.equal(result.cachedInputTokens, 200);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.periodSeconds, WEEK_SECONDS);
  assert.equal(
    result.periodStartAt,
    new Date((resetsAtSec - WEEK_SECONDS) * 1000).toISOString(),
  );
  assert.equal(result.models[0].estimatedTokens, 600);
  assert.equal(result.models[0].cachedInputTokens, 200);
});

test("falls back to the trailing 7 days when events carry no rate_limits", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const oldTimestamp = new Date(now - 6 * DAY_MS).toISOString();
  const recentTimestamp = new Date(now - 1 * DAY_MS).toISOString();

  const result = await withSessionDir(
    {
      "rollout-plain.jsonl": [
        tokenCountLine(oldTimestamp, {
          total: 1_000,
          last: 1_000,
          cached: 700,
          cachedLast: 700,
        }),
        tokenCountLine(recentTimestamp, {
          total: 1_600,
          last: 600,
          cached: 900,
          cachedLast: 200,
        }),
      ],
    },
    async (codexHome) => {
      const estimate = await estimateCodexSessionLogTokens(
        { CODEX_HOME: codexHome },
        now,
      );
      const disabled = await estimateCodexSessionLogTokens(
        { CODEX_HOME: codexHome, USAGE_HUB_CODEX_LOG_ESTIMATE: "off" },
        now,
      );
      return { estimate, disabled };
    },
  );

  assert.equal(result.disabled, null);
  assert.equal(result.estimate.totalTokens, 1_600);
  assert.equal(result.estimate.cachedInputTokens, 900);
  assert.equal(result.estimate.periodSeconds, WEEK_SECONDS);
  assert.equal(
    result.estimate.periodStartAt,
    new Date(now - 7 * DAY_MS).toISOString(),
  );
});

test("returns no quota token estimate without a user-calibrated capacity", () => {
  const windows = [
    { id: "five_hour", usedPercent: 80 },
    { id: "weekly", usedPercent: 25 },
    { id: "weekly_reasoning", usedPercent: 40 },
  ];

  for (const capacityTokens of [undefined, "", "0", "not-a-number"]) {
    assert.equal(
      estimateWeeklyQuotaTokens(windows, {
        id: "example-subscription",
        label: "Example AI 综合订阅",
        capacityTokens,
        scopedModels: [
          {
            id: "example-reasoning-model",
            label: "Reasoning 模型独立额度",
            windowId: "weekly_reasoning",
            capacityTokens: 5_000_000,
          },
        ],
      }),
      null,
    );
  }
});

test("converts quota percentages only with an explicitly configured capacity", () => {
  const result = estimateWeeklyQuotaTokens(
    [
      { id: "five_hour", usedPercent: 80 },
      { id: "weekly", usedPercent: 25 },
      { id: "weekly_reasoning", usedPercent: 40 },
    ],
    {
      id: "example-subscription",
      label: "Example AI 综合订阅",
      capacityTokens: "10000000",
      scopedModels: [
        {
          id: "example-reasoning-model",
          label: "Reasoning 模型独立额度",
          windowId: "weekly_reasoning",
          capacityTokens: 5_000_000,
        },
        {
          id: "example-uncalibrated-model",
          label: "未校准模型额度",
          windowId: "five_hour",
        },
      ],
    },
  );

  assert.equal(result.basis, "quota_percentage");
  assert.equal(result.totalTokens, 2_500_000);
  assert.equal(result.capacityTokens, 10_000_000);
  assert.equal(result.models.length, 2);
  assert.equal(result.models[1].estimatedTokens, 2_000_000);
  assert.equal(result.models[1].countedInTotal, false);
  assert.match(result.assumption, /校准值/);
});
