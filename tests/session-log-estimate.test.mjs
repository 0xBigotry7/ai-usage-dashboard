import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { estimateWeeklyQuotaTokens } from "../collector/quota-estimate.mjs";
import {
  estimateCodexSessionLogTokenEstimates,
  estimateCodexSessionLogTokens,
  summarizeTokenCountRecords,
} from "../collector/session-log-estimate.mjs";

const DAY_MS = 86_400_000;
const WEEK_SECONDS = 604_800;

test("sums counter deltas and starts a new epoch on counter reset", () => {
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
  // + 60 (delta) + 30 (the complete new cumulative epoch after reset).
  assert.equal(result.totalTokens, 280);
  assert.equal(result.sessionCount, 1);
  assert.deepEqual(
    result.models.map((model) => [model.label, model.estimatedTokens]),
    [["gpt-example", 280]],
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
        totalTokens: 300_000,
        lastTokens: 128_017,
        inheritedCounter: true,
        model: "gpt-example",
      },
      {
        sessionId: "rollout-fork",
        timestamp: 4_000,
        totalTokens: 305_000,
        lastTokens: 5_000,
        model: "gpt-example",
      },
    ],
    0,
  );

  // Parent: 500 + 150. Fork: 128,017 (only the new turn, not the inherited
  // 300K counter) + 5,000 delta. The first ratio is below the legacy 3x
  // heuristic, so this specifically proves metadata-driven deduplication.
  assert.equal(result.totalTokens, 133_667);
  assert.equal(result.sessionCount, 2);
});

test("deduplicates parent token history replayed inside a fork file", () => {
  const parentRecords = [
    {
      sessionId: "rollout-parent",
      rolloutId: "rollout-parent",
      timestamp: 1_000,
      totalTokens: 100,
      lastTokens: 100,
      inputTokens: 80,
      inputLastTokens: 80,
      cachedTokens: 50,
      cachedLastTokens: 50,
      outputTokens: 20,
      outputLastTokens: 20,
      reasoningOutputTokens: 5,
      reasoningOutputLastTokens: 5,
      inheritedCounter: false,
      model: "gpt-example",
    },
    {
      sessionId: "rollout-parent",
      rolloutId: "rollout-parent",
      timestamp: 2_000,
      totalTokens: 150,
      lastTokens: 50,
      inputTokens: 120,
      inputLastTokens: 40,
      cachedTokens: 75,
      cachedLastTokens: 25,
      outputTokens: 30,
      outputLastTokens: 10,
      reasoningOutputTokens: 8,
      reasoningOutputLastTokens: 3,
      inheritedCounter: false,
      model: "gpt-example",
    },
  ];
  const result = summarizeTokenCountRecords(
    [
      ...parentRecords,
      ...parentRecords.map((record) => ({
        ...record,
        sessionId: "rollout-fork",
        rolloutId: "rollout-fork",
        parentRolloutId: "rollout-parent",
        inheritedCounter: true,
      })),
      {
        sessionId: "rollout-fork",
        rolloutId: "rollout-fork",
        parentRolloutId: "rollout-parent",
        timestamp: 3_000,
        totalTokens: 200,
        lastTokens: 50,
        inputTokens: 160,
        inputLastTokens: 40,
        cachedTokens: 100,
        cachedLastTokens: 25,
        outputTokens: 40,
        outputLastTokens: 10,
        reasoningOutputTokens: 10,
        reasoningOutputLastTokens: 2,
        inheritedCounter: true,
        model: "gpt-example",
      },
      {
        sessionId: "rollout-fork",
        rolloutId: "rollout-fork",
        parentRolloutId: "rollout-parent",
        timestamp: 4_000,
        totalTokens: 260,
        lastTokens: 60,
        inputTokens: 205,
        inputLastTokens: 45,
        cachedTokens: 130,
        cachedLastTokens: 30,
        outputTokens: 55,
        outputLastTokens: 15,
        reasoningOutputTokens: 14,
        reasoningOutputLastTokens: 4,
        inheritedCounter: true,
        model: "gpt-example",
      },
    ],
    0,
  );

  // Parent contributes 150. The fork's replayed parent events contribute
  // nothing; only its two new turns (50 + 60) are added.
  assert.equal(result.totalTokens, 260);
  assert.equal(result.inputTokens, 205);
  assert.equal(result.cachedInputTokens, 130);
  assert.equal(result.outputTokens, 55);
  assert.equal(result.reasoningOutputTokens, 14);
});

function replayRecord({
  rolloutId,
  parentRolloutId,
  timestamp,
  totalTokens,
  lastTokens,
}) {
  return {
    sessionId: rolloutId,
    rolloutId,
    parentRolloutId,
    timestamp,
    totalTokens,
    lastTokens,
    inheritedCounter: Boolean(parentRolloutId),
    model: "gpt-example",
  };
}

test("deduplicates a compacted fork that replays a parent suffix", () => {
  const result = summarizeTokenCountRecords(
    [
      replayRecord({
        rolloutId: "parent",
        timestamp: 1,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "parent",
        timestamp: 2,
        totalTokens: 150,
        lastTokens: 50,
      }),
      replayRecord({
        rolloutId: "parent",
        timestamp: 3,
        totalTokens: 210,
        lastTokens: 60,
      }),
      replayRecord({
        rolloutId: "child",
        parentRolloutId: "parent",
        timestamp: 4,
        totalTokens: 150,
        lastTokens: 50,
      }),
      replayRecord({
        rolloutId: "child",
        parentRolloutId: "parent",
        timestamp: 5,
        totalTokens: 210,
        lastTokens: 60,
      }),
      replayRecord({
        rolloutId: "child",
        parentRolloutId: "parent",
        timestamp: 6,
        totalTokens: 260,
        lastTokens: 50,
      }),
    ],
    0,
  );

  assert.equal(result.totalTokens, 260);
});

test("retains the final replayed state as the child delta baseline", () => {
  const result = summarizeTokenCountRecords(
    [
      replayRecord({
        rolloutId: "parent",
        timestamp: 1,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "parent",
        timestamp: 2,
        totalTokens: 150,
        lastTokens: 50,
      }),
      replayRecord({
        rolloutId: "child",
        parentRolloutId: "parent",
        timestamp: 3,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "child",
        parentRolloutId: "parent",
        timestamp: 4,
        totalTokens: 150,
        lastTokens: 50,
      }),
      replayRecord({
        rolloutId: "child",
        parentRolloutId: "parent",
        timestamp: 5,
        totalTokens: 300,
        lastTokens: 50,
      }),
    ],
    0,
  );

  // The novel child observation is 150 tokens beyond the replay baseline.
  // Counting only last_token_usage would lose the unobserved 100-token gap.
  assert.equal(result.totalTokens, 300);
});

test("counts a shared prefix once when sibling forks have a missing ancestor", () => {
  const result = summarizeTokenCountRecords(
    [
      replayRecord({
        rolloutId: "child-a",
        parentRolloutId: "missing-parent",
        timestamp: 1,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "child-a",
        parentRolloutId: "missing-parent",
        timestamp: 2,
        totalTokens: 150,
        lastTokens: 50,
      }),
      replayRecord({
        rolloutId: "child-b",
        parentRolloutId: "missing-parent",
        timestamp: 3,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "child-b",
        parentRolloutId: "missing-parent",
        timestamp: 4,
        totalTokens: 160,
        lastTokens: 60,
      }),
    ],
    0,
  );

  assert.equal(result.totalTokens, 210);
});

test("keeps novel usage from parallel sibling forks", () => {
  const result = summarizeTokenCountRecords(
    [
      replayRecord({
        rolloutId: "parent",
        timestamp: 1,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "child-a",
        parentRolloutId: "parent",
        timestamp: 2,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "child-a",
        parentRolloutId: "parent",
        timestamp: 3,
        totalTokens: 150,
        lastTokens: 50,
      }),
      replayRecord({
        rolloutId: "child-b",
        parentRolloutId: "parent",
        timestamp: 4,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "child-b",
        parentRolloutId: "parent",
        timestamp: 5,
        totalTokens: 160,
        lastTokens: 60,
      }),
    ],
    0,
  );

  assert.equal(result.totalTokens, 210);
});

test("deduplicates replay through a child-of-child lineage", () => {
  const result = summarizeTokenCountRecords(
    [
      replayRecord({
        rolloutId: "parent",
        timestamp: 1,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "child",
        parentRolloutId: "parent",
        timestamp: 2,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "child",
        parentRolloutId: "parent",
        timestamp: 3,
        totalTokens: 150,
        lastTokens: 50,
      }),
      replayRecord({
        rolloutId: "grandchild",
        parentRolloutId: "child",
        timestamp: 4,
        totalTokens: 100,
        lastTokens: 100,
      }),
      replayRecord({
        rolloutId: "grandchild",
        parentRolloutId: "child",
        timestamp: 5,
        totalTokens: 150,
        lastTokens: 50,
      }),
      replayRecord({
        rolloutId: "grandchild",
        parentRolloutId: "child",
        timestamp: 6,
        totalTokens: 190,
        lastTokens: 40,
      }),
    ],
    0,
  );

  assert.equal(result.totalTokens, 190);
});

test("does not count repeated cumulative token events twice", () => {
  const result = summarizeTokenCountRecords(
    [
      {
        sessionId: "session-duplicate",
        timestamp: 1_000,
        totalTokens: 100,
        lastTokens: 100,
        inputTokens: 90,
        inputLastTokens: 90,
        cachedTokens: 60,
        cachedLastTokens: 60,
        outputTokens: 10,
        outputLastTokens: 10,
        inheritedCounter: false,
        model: "gpt-example",
      },
      {
        sessionId: "session-duplicate",
        timestamp: 2_000,
        totalTokens: 100,
        lastTokens: 90,
        inputTokens: 90,
        inputLastTokens: 80,
        cachedTokens: 60,
        cachedLastTokens: 50,
        outputTokens: 10,
        outputLastTokens: 10,
        inheritedCounter: false,
        model: "gpt-example",
      },
    ],
    0,
  );

  assert.equal(result.totalTokens, 100);
  assert.equal(result.cachedInputTokens, 60);
});

test("does not count token events after the requested reporting cutoff", () => {
  const result = summarizeTokenCountRecords(
    [
      {
        sessionId: "session-cutoff",
        timestamp: 1_000,
        totalTokens: 100,
        inputTokens: 80,
        outputTokens: 20,
        model: "gpt-example",
      },
      {
        sessionId: "session-cutoff",
        timestamp: 2_000,
        totalTokens: 175,
        inputTokens: 140,
        outputTokens: 35,
        model: "gpt-example",
      },
      {
        sessionId: "session-cutoff",
        timestamp: 3_000,
        totalTokens: 250,
        inputTokens: 200,
        outputTokens: 50,
        model: "gpt-example",
      },
    ],
    0,
    2_000,
  );

  assert.equal(result.totalTokens, 175);
  assert.equal(result.inputTokens, 140);
  assert.equal(result.outputTokens, 35);
});

test("does not invent a zero input/output breakdown for total-only logs", () => {
  const result = summarizeTokenCountRecords(
    [
      {
        sessionId: "legacy-total-only",
        timestamp: 1_000,
        totalTokens: 1_234,
        lastTokens: 1_234,
        model: "gpt-example",
      },
    ],
    0,
  );

  assert.equal(result.totalTokens, 1_234);
  assert.equal("inputTokens" in result, false);
  assert.equal("outputTokens" in result, false);
  assert.equal("inputTokens" in result.models[0], false);
  assert.equal("outputTokens" in result.models[0], false);
});

test("omits impossible cached-input and reasoning-output subsets", () => {
  const result = summarizeTokenCountRecords(
    [
      {
        sessionId: "invalid-subsets",
        timestamp: 1_000,
        totalTokens: 100,
        inputTokens: 80,
        cachedTokens: 90,
        outputTokens: 20,
        reasoningOutputTokens: 30,
        model: "gpt-example",
      },
    ],
    0,
  );

  assert.equal(result.totalTokens, 100);
  assert.equal(result.inputTokens, 80);
  assert.equal(result.outputTokens, 20);
  assert.equal("cachedInputTokens" in result, false);
  assert.equal("reasoningOutputTokens" in result, false);
  assert.equal("cachedInputTokens" in result.models[0], false);
  assert.equal("reasoningOutputTokens" in result.models[0], false);
});

test("tracks cached input tokens with the same counter-delta method", () => {
  const result = summarizeTokenCountRecords(
    [
      {
        sessionId: "session-c",
        timestamp: 1_000,
        totalTokens: 1_000,
        lastTokens: 1_000,
        inputTokens: 900,
        inputLastTokens: 900,
        cachedTokens: 800,
        cachedLastTokens: 800,
        outputTokens: 100,
        outputLastTokens: 100,
        model: "gpt-example",
      },
      {
        sessionId: "session-c",
        timestamp: 2_000,
        totalTokens: 1_500,
        lastTokens: 500,
        inputTokens: 1_350,
        inputLastTokens: 450,
        cachedTokens: 1_200,
        cachedLastTokens: 400,
        outputTokens: 150,
        outputLastTokens: 50,
        model: "gpt-example",
      },
      {
        sessionId: "session-c",
        timestamp: 3_000,
        totalTokens: 1_600,
        lastTokens: 100,
        inputTokens: 1_450,
        inputLastTokens: 100,
        cachedTokens: 1_250,
        cachedLastTokens: 50,
        outputTokens: 150,
        outputLastTokens: 0,
        model: "gpt-example",
      },
      {
        sessionId: "session-d-fork",
        timestamp: 4_000,
        totalTokens: 9_000,
        lastTokens: 300,
        inputTokens: 8_500,
        inputLastTokens: 250,
        cachedTokens: 6_000,
        cachedLastTokens: 120,
        outputTokens: 500,
        outputLastTokens: 50,
        model: "gpt-example-mini",
      },
      {
        sessionId: "session-d-fork",
        timestamp: 5_000,
        totalTokens: 9_300,
        lastTokens: 300,
        inputTokens: 8_750,
        inputLastTokens: 250,
        cachedTokens: 6_150,
        cachedLastTokens: 150,
        outputTokens: 550,
        outputLastTokens: 50,
        model: "gpt-example-mini",
      },
    ],
    0,
  );

  // session-c: 1000 + 500 + 100 total, 800 + 400 + 50 cached.
  // session-d-fork (inherited counter): 300 + 300 total, 120 + 150 cached.
  assert.equal(result.totalTokens, 2_200);
  assert.equal(result.inputTokens, 1_950);
  assert.equal(result.outputTokens, 250);
  assert.equal(result.cachedInputTokens, 1_520);
  assert.deepEqual(
    result.models.map((model) => [
      model.label,
      model.estimatedTokens,
      model.cachedInputTokens,
    ]),
    [
      ["gpt-example", 1_600, 1_250],
      ["gpt-example-mini", 600, 270],
    ],
  );
});

function tokenCountLine(
  timestamp,
  {
    total,
    last,
    input,
    inputLast,
    cached,
    cachedLast,
    output,
    outputLast,
    reasoning,
    reasoningLast,
    primary,
    secondary,
  } = {},
) {
  const normalizedOutput = output ?? 0;
  const normalizedInput = input ?? Math.max(0, (total ?? 0) - normalizedOutput);
  const normalizedOutputLast = outputLast ?? 0;
  const normalizedInputLast =
    inputLast ?? Math.max(0, (last ?? 0) - normalizedOutputLast);
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: normalizedInput,
          cached_input_tokens: cached ?? 0,
          output_tokens: normalizedOutput,
          reasoning_output_tokens: reasoning ?? 0,
          total_tokens: total,
        },
        last_token_usage:
          last === undefined
            ? undefined
            : {
                input_tokens: normalizedInputLast,
                cached_input_tokens: cachedLast ?? 0,
                output_tokens: normalizedOutputLast,
                reasoning_output_tokens: reasoningLast ?? 0,
                total_tokens: last,
              },
      },
      ...(primary || secondary
        ? {
            rate_limits: {
              ...(primary ? { primary } : {}),
              ...(secondary ? { secondary } : {}),
            },
          }
        : {}),
    },
  });
}

test("reports today's input and output separately from the billing cycle", async () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const nowMs = now.getTime();
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const beforeToday = new Date(todayStart.getTime() - 60 * 60 * 1000).toISOString();
  const firstToday = new Date(todayStart.getTime() + 60 * 60 * 1000).toISOString();
  const secondToday = new Date(todayStart.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const resetsAtSec = nowMs / 1000 + 3 * 86_400;
  const weekly = {
    used_percent: 25,
    window_minutes: 10_080,
    resets_at: resetsAtSec,
  };

  const results = await withSessionDir(
    {
      "rollout-daily-breakdown.jsonl": [
        tokenCountLine(beforeToday, {
          total: 1_000,
          last: 1_000,
          input: 800,
          inputLast: 800,
          cached: 500,
          cachedLast: 500,
          output: 200,
          outputLast: 200,
          reasoning: 50,
          reasoningLast: 50,
          primary: weekly,
        }),
        tokenCountLine(firstToday, {
          total: 1_500,
          last: 500,
          input: 1_180,
          inputLast: 380,
          cached: 700,
          cachedLast: 200,
          output: 320,
          outputLast: 120,
          reasoning: 80,
          reasoningLast: 30,
          primary: weekly,
        }),
        tokenCountLine(secondToday, {
          total: 1_700,
          last: 200,
          input: 1_330,
          inputLast: 150,
          cached: 800,
          cachedLast: 100,
          output: 370,
          outputLast: 50,
          reasoning: 100,
          reasoningLast: 20,
          primary: weekly,
        }),
      ],
    },
    (codexHome) =>
      estimateCodexSessionLogTokenEstimates({ CODEX_HOME: codexHome }, nowMs),
  );
  const result = results.find((estimate) => estimate.periodId === "today");
  const billingCycle = results.find(
    (estimate) => estimate.periodId === "weekly_cycle",
  );

  assert.equal(result.periodId, "today");
  assert.equal(result.periodStartAt, todayStart.toISOString());
  assert.equal(result.estimated, false);
  assert.equal(result.totalTokens, 700);
  assert.equal(result.inputTokens, 530);
  assert.equal(result.cachedInputTokens, 300);
  assert.equal(result.outputTokens, 170);
  assert.equal(result.reasoningOutputTokens, 50);
  assert.equal(result.models[0].inputTokens, 530);
  assert.equal(result.models[0].outputTokens, 170);
  assert.equal(billingCycle.totalTokens, 1_700);
  assert.equal(billingCycle.inputTokens, 1_330);
  assert.equal(billingCycle.outputTokens, 370);
});

function sessionMetaLine(
  timestamp,
  {
    id,
    sessionId = id,
    parentThreadId,
    forkedFromId,
  },
) {
  return JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id,
      session_id: sessionId,
      ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
      ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
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

test("reads fork metadata instead of guessing from the counter ratio", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const timestamp = new Date(now - DAY_MS).toISOString();
  const result = await withSessionDir(
    {
      "rollout-child.jsonl": [
        sessionMetaLine(timestamp, {
          id: "rollout-child",
          sessionId: "rollout-parent",
          parentThreadId: "rollout-parent",
          forkedFromId: "rollout-parent",
        }),
        sessionMetaLine(timestamp, {
          id: "rollout-parent",
        }),
        tokenCountLine(timestamp, {
          total: 300_000,
          last: 128_017,
          cached: 180_000,
          cachedLast: 70_000,
        }),
      ],
    },
    (codexHome) =>
      estimateCodexSessionLogTokens({ CODEX_HOME: codexHome }, now),
  );

  assert.equal(result.totalTokens, 128_017);
  assert.equal(result.cachedInputTokens, 70_000);
});

test("uses a primary weekly limit when Codex omits secondary", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const resetsAtSec = now / 1000 + 5 * 86_400;
  const primary = {
    used_percent: 22,
    window_minutes: 10_080,
    resets_at: resetsAtSec,
  };
  const outsideWindow = new Date(now - 3 * DAY_MS).toISOString();
  const insideWindow = new Date(now - DAY_MS).toISOString();

  const result = await withSessionDir(
    {
      "rollout-primary-weekly.jsonl": [
        tokenCountLine(outsideWindow, {
          total: 1_000,
          last: 1_000,
          cached: 700,
          cachedLast: 700,
          primary,
        }),
        tokenCountLine(insideWindow, {
          total: 1_600,
          last: 600,
          cached: 900,
          cachedLast: 200,
          primary,
        }),
      ],
    },
    (codexHome) =>
      estimateCodexSessionLogTokens({ CODEX_HOME: codexHome }, now),
  );

  assert.equal(result.totalTokens, 600);
  assert.equal(result.cachedInputTokens, 200);
  assert.equal(
    result.periodStartAt,
    new Date((resetsAtSec - WEEK_SECONDS) * 1000).toISOString(),
  );
});

test("aligns the log window with the quota cycle from rate_limits.secondary", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const resetsAtSec = now / 1000 + 3 * 86_400;
  const secondary = {
    used_percent: 19,
    window_minutes: 10_080,
    resets_at: resetsAtSec,
  };
  const primary = {
    used_percent: 70,
    window_minutes: 300,
    resets_at: now / 1000 + 3_600,
  };
  const oldTimestamp = new Date(now - 6 * DAY_MS).toISOString();
  const recentTimestamp = new Date(now - 1 * DAY_MS).toISOString();
  // Same event as tokenCountLine(recentTimestamp, ...) but written with
  // whitespace around colons, which the line pre-filter must tolerate.
  const spacedRecentLine =
    `{ "timestamp": "${recentTimestamp}", "type": "event_msg", ` +
    `"payload": { "type": "token_count", "info": { ` +
    `"total_token_usage": { "total_tokens": 1600, "input_tokens": 1600, ` +
    `"cached_input_tokens": 900, "output_tokens": 0 }, ` +
    `"last_token_usage": { "total_tokens": 600, "input_tokens": 600, ` +
    `"cached_input_tokens": 200, "output_tokens": 0 } }, ` +
    `"rate_limits": { "primary": { "window_minutes": 300, ` +
    `"resets_at": ${now / 1000 + 3_600} }, "secondary": { ` +
    `"window_minutes": 10080, "resets_at": ${resetsAtSec} } } } }`;

  const result = await withSessionDir(
    {
      "rollout-aligned.jsonl": [
        tokenCountLine(oldTimestamp, {
          total: 1_000,
          last: 1_000,
          cached: 700,
          cachedLast: 700,
          primary,
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
  assert.equal(result.estimated, false);
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

test("ignores an expired quota window and falls back to the trailing week", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const expiredResetSec = now / 1000 - DAY_MS / 1000;
  const secondary = {
    used_percent: 90,
    window_minutes: 10_080,
    resets_at: expiredResetSec,
  };
  const outsideFallback = new Date(now - 7.5 * DAY_MS).toISOString();
  const recentTimestamp = new Date(now - DAY_MS / 2).toISOString();

  const result = await withSessionDir(
    {
      "rollout-expired-window.jsonl": [
        tokenCountLine(outsideFallback, {
          total: 1_000,
          last: 1_000,
          cached: 700,
          cachedLast: 700,
          secondary,
        }),
        tokenCountLine(recentTimestamp, {
          total: 1_600,
          last: 600,
          cached: 900,
          cachedLast: 200,
          secondary,
        }),
      ],
    },
    (codexHome) =>
      estimateCodexSessionLogTokens({ CODEX_HOME: codexHome }, now),
  );

  assert.equal(result.totalTokens, 600);
  assert.equal(result.cachedInputTokens, 200);
  assert.equal(
    result.periodStartAt,
    new Date(now - 7 * DAY_MS).toISOString(),
  );
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
  assert.equal(result.periodId, "weekly_quota");
  assert.equal(result.scope, "calibrated_quota");
  assert.equal(result.totalTokens, 2_500_000);
  assert.equal(result.capacityTokens, 10_000_000);
  assert.equal(result.models.length, 2);
  assert.equal(result.models[1].estimatedTokens, 2_000_000);
  assert.equal(result.models[1].countedInTotal, false);
  assert.match(result.assumption, /校准值/);
});
