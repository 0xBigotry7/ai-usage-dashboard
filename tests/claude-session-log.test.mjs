import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  _cacheStats,
  claudeProjectsDir,
  estimateClaudeSessionLogTokenEstimates,
} from "../collector/claude-session-log.mjs";
import { collectClaudeCodeUsage } from "../collector/providers/claude-code.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEK_SECONDS = 604_800;

let syntheticId = 0;

function assistantLine(
  timestamp,
  {
    requestId = `req-${(syntheticId += 1)}`,
    messageId,
    uuid = `uuid-${(syntheticId += 1)}`,
    model = "claude-test-model",
    sessionId = "session-1",
    sidechain = false,
    input = 0,
    cacheCreate = 0,
    cacheRead = 0,
    output = 0,
  } = {},
) {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: sidechain,
    sessionId,
    type: "assistant",
    uuid,
    timestamp: new Date(timestamp).toISOString(),
    requestId,
    message: {
      ...(messageId ? { id: messageId } : {}),
      type: "message",
      role: "assistant",
      model,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
    },
  });
}

async function withClaudeConfigDir(files, run) {
  const configDir = await mkdtemp(join(tmpdir(), "usage-hub-claude-logs-"));
  try {
    const projectDir = join(configDir, "projects", "-Users-synthetic-project");
    await mkdir(projectDir, { recursive: true });
    for (const [name, lines] of Object.entries(files)) {
      await writeFile(join(projectDir, name), `${lines.join("\n")}\n`);
    }
    return await run(configDir, projectDir);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

function fixedNoon() {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  return now.getTime();
}

test("deduplicates repeated logs of the same API call, keeping the last occurrence", async () => {
  const now = fixedNoon();
  const recent = now - 30 * 60_000;
  const estimates = await withClaudeConfigDir(
    {
      "session-1.jsonl": [
        assistantLine(recent, {
          requestId: "req-dup",
          messageId: "msg-dup",
          input: 100,
          cacheRead: 40,
          output: 10,
        }),
        assistantLine(recent, {
          requestId: "req-dup",
          messageId: "msg-dup",
          input: 100,
          cacheRead: 40,
          output: 50,
        }),
        assistantLine(recent, {
          requestId: "req-other",
          messageId: "msg-other",
          input: 10,
          cacheCreate: 6,
          output: 5,
        }),
      ],
    },
    (configDir) =>
      estimateClaudeSessionLogTokenEstimates(
        { CLAUDE_CONFIG_DIR: configDir },
        now,
      ),
  );

  const rolling = estimates.find((estimate) => estimate.periodId === "rolling_7d");
  assert.equal(rolling.basis, "session_logs");
  assert.equal(rolling.scope, "local_device");
  assert.equal(rolling.estimated, false);
  // msg-dup counts once with its final usage: input 100 + cacheRead 40,
  // output 50. msg-other adds input 10 + cacheCreate 6, output 5.
  assert.equal(rolling.inputTokens, 156);
  assert.equal(rolling.outputTokens, 55);
  assert.equal(rolling.cachedInputTokens, 40);
  assert.equal(rolling.totalTokens, 211);
  assert.equal(rolling.sessionCount, 1);
  assert.deepEqual(
    rolling.models.map((model) => [model.id, model.estimatedTokens]),
    [["claude-log-claude-test-model", 211]],
  );
});

test("includes subagent sidechain turns in the totals", async () => {
  const now = fixedNoon();
  const recent = now - HOUR_MS;
  const estimates = await withClaudeConfigDir(
    {
      "session-1.jsonl": [
        assistantLine(recent, { messageId: "msg-main", input: 100, output: 20 }),
        assistantLine(recent, {
          messageId: "msg-side",
          sidechain: true,
          input: 300,
          output: 40,
        }),
      ],
    },
    (configDir) =>
      estimateClaudeSessionLogTokenEstimates(
        { CLAUDE_CONFIG_DIR: configDir },
        now,
      ),
  );

  const rolling = estimates.find((estimate) => estimate.periodId === "rolling_7d");
  assert.equal(rolling.totalTokens, 460);
  assert.equal(rolling.inputTokens, 400);
  assert.equal(rolling.outputTokens, 60);
});

test("skips synthetic models and records without a usable usage block", async () => {
  const now = fixedNoon();
  const recent = now - HOUR_MS;
  const estimates = await withClaudeConfigDir(
    {
      "session-1.jsonl": [
        assistantLine(recent, { messageId: "msg-real", input: 50, output: 5 }),
        assistantLine(recent, {
          messageId: "msg-synthetic",
          model: "<synthetic>",
          input: 9_999,
          output: 9_999,
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(recent).toISOString(),
          uuid: "uuid-null-usage",
          message: { model: "claude-test-model", usage: null },
        }),
        JSON.stringify({
          type: "user",
          timestamp: new Date(recent).toISOString(),
          uuid: "uuid-user",
          message: { usage: { input_tokens: 7_777 } },
        }),
        '{broken "usage" line',
      ],
    },
    (configDir) =>
      estimateClaudeSessionLogTokenEstimates(
        { CLAUDE_CONFIG_DIR: configDir },
        now,
      ),
  );

  const rolling = estimates.find((estimate) => estimate.periodId === "rolling_7d");
  assert.equal(rolling.totalTokens, 55);
  assert.equal(rolling.estimated, false);
});

test("separates today from the rolling week at the local midnight boundary", async () => {
  const now = fixedNoon();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const beforeMidnight = todayStart.getTime() - HOUR_MS;
  const afterMidnight = todayStart.getTime() + HOUR_MS;
  const estimates = await withClaudeConfigDir(
    {
      "session-1.jsonl": [
        assistantLine(beforeMidnight, {
          messageId: "msg-yesterday",
          input: 1_000,
          output: 100,
        }),
        assistantLine(afterMidnight, {
          messageId: "msg-today",
          input: 200,
          cacheRead: 80,
          output: 30,
        }),
      ],
    },
    (configDir) =>
      estimateClaudeSessionLogTokenEstimates(
        { CLAUDE_CONFIG_DIR: configDir },
        now,
      ),
  );

  const today = estimates.find((estimate) => estimate.periodId === "today");
  const rolling = estimates.find((estimate) => estimate.periodId === "rolling_7d");
  assert.equal(today.totalTokens, 310);
  assert.equal(today.inputTokens, 280);
  assert.equal(today.cachedInputTokens, 80);
  assert.equal(today.outputTokens, 30);
  assert.equal(today.periodStartAt, todayStart.toISOString());
  assert.equal(rolling.totalTokens, 1_410);
  assert.equal(rolling.periodSeconds, WEEK_SECONDS);
  assert.equal(
    rolling.periodStartAt,
    new Date(now - WEEK_SECONDS * 1000).toISOString(),
  );
});

test("skips files whose mtime is older than the eight-day pre-filter window", async () => {
  const now = fixedNoon();
  const recent = now - HOUR_MS;
  const estimates = await withClaudeConfigDir(
    {
      "session-fresh.jsonl": [
        assistantLine(recent, { messageId: "msg-fresh", input: 100, output: 10 }),
      ],
      "session-stale.jsonl": [
        assistantLine(recent, {
          messageId: "msg-stale",
          input: 500_000,
          output: 500_000,
        }),
      ],
    },
    async (configDir, projectDir) => {
      const staleSeconds = (now - 10 * DAY_MS) / 1000;
      await utimes(
        join(projectDir, "session-stale.jsonl"),
        staleSeconds,
        staleSeconds,
      );
      return estimateClaudeSessionLogTokenEstimates(
        { CLAUDE_CONFIG_DIR: configDir },
        now,
      );
    },
  );

  const rolling = estimates.find((estimate) => estimate.periodId === "rolling_7d");
  assert.equal(rolling.totalTokens, 110);
  assert.equal(rolling.estimated, false);
});

test("marks estimates as approximate when a session log cannot be read", async () => {
  const now = fixedNoon();
  const recent = now - HOUR_MS;
  const estimates = await withClaudeConfigDir(
    {
      "session-good.jsonl": [
        assistantLine(recent, { messageId: "msg-good", input: 100, output: 10 }),
      ],
    },
    async (configDir, projectDir) => {
      await symlink(
        join(projectDir, "missing-target.jsonl"),
        join(projectDir, "broken.jsonl"),
      );
      return estimateClaudeSessionLogTokenEstimates(
        { CLAUDE_CONFIG_DIR: configDir },
        now,
      );
    },
  );

  assert.equal(estimates.length, 2);
  for (const estimate of estimates) {
    assert.equal(estimate.estimated, true);
    assert.match(estimate.assumption, /approximate/);
  }
  const rolling = estimates.find((estimate) => estimate.periodId === "rolling_7d");
  assert.equal(rolling.totalTokens, 110);
});

test("can be disabled with the USAGE_HUB_CLAUDE_LOG_ESTIMATE toggle", async () => {
  const now = fixedNoon();
  const estimates = await withClaudeConfigDir(
    {
      "session-1.jsonl": [
        assistantLine(now - HOUR_MS, { messageId: "msg-1", input: 10, output: 1 }),
      ],
    },
    (configDir) =>
      estimateClaudeSessionLogTokenEstimates(
        { CLAUDE_CONFIG_DIR: configDir, USAGE_HUB_CLAUDE_LOG_ESTIMATE: "off" },
        now,
      ),
  );

  assert.deepEqual(estimates, []);
});

test("serves warm scans from the per-file cache with identical estimates", async () => {
  const now = fixedNoon();
  const recent = now - HOUR_MS;
  await withClaudeConfigDir(
    {
      "session-1.jsonl": [
        assistantLine(recent, { messageId: "msg-a", input: 100, output: 10 }),
      ],
      "session-2.jsonl": [
        assistantLine(recent, { messageId: "msg-b", input: 200, output: 20 }),
      ],
    },
    async (configDir) => {
      const env = { CLAUDE_CONFIG_DIR: configDir };
      const cold = await estimateClaudeSessionLogTokenEstimates(env, now);
      const coldStats = _cacheStats();
      assert.equal(coldStats.files, 2);
      assert.equal(coldStats.misses, 2);
      assert.equal(coldStats.hits, 0);

      const warm = await estimateClaudeSessionLogTokenEstimates(env, now);
      const warmStats = _cacheStats();
      assert.equal(warmStats.files, 2);
      assert.equal(warmStats.hits, 2);
      assert.equal(warmStats.misses, 0);
      // Correctness invariant: cached records must aggregate to exactly the
      // same estimates a from-disk scan produces.
      assert.deepEqual(warm, cold);
    },
  );
});

test("re-parses only files that changed and folds in their new totals", async () => {
  const now = fixedNoon();
  const recent = now - HOUR_MS;
  await withClaudeConfigDir(
    {
      "session-1.jsonl": [
        assistantLine(recent, { messageId: "msg-a", input: 100, output: 10 }),
      ],
      "session-2.jsonl": [
        assistantLine(recent, { messageId: "msg-b", input: 200, output: 20 }),
      ],
    },
    async (configDir, projectDir) => {
      const env = { CLAUDE_CONFIG_DIR: configDir };
      await estimateClaudeSessionLogTokenEstimates(env, now);

      await appendFile(
        join(projectDir, "session-2.jsonl"),
        `${assistantLine(recent, { messageId: "msg-c", input: 40, output: 4 })}\n`,
      );
      const estimates = await estimateClaudeSessionLogTokenEstimates(env, now);
      const stats = _cacheStats();
      assert.equal(stats.hits, 1);
      assert.equal(stats.misses, 1);
      const rolling = estimates.find(
        (estimate) => estimate.periodId === "rolling_7d",
      );
      assert.equal(rolling.totalTokens, 374);
      assert.equal(rolling.inputTokens, 340);
      assert.equal(rolling.outputTokens, 34);
    },
  );
});

test("evicts cache entries for files that leave the mtime window", async () => {
  const now = fixedNoon();
  const recent = now - HOUR_MS;
  await withClaudeConfigDir(
    {
      "session-keep.jsonl": [
        assistantLine(recent, { messageId: "msg-keep", input: 100, output: 10 }),
      ],
      "session-age-out.jsonl": [
        assistantLine(recent, { messageId: "msg-old", input: 500, output: 50 }),
      ],
    },
    async (configDir, projectDir) => {
      const env = { CLAUDE_CONFIG_DIR: configDir };
      await estimateClaudeSessionLogTokenEstimates(env, now);
      assert.equal(_cacheStats().files, 2);

      const staleSeconds = (now - 10 * DAY_MS) / 1000;
      await utimes(
        join(projectDir, "session-age-out.jsonl"),
        staleSeconds,
        staleSeconds,
      );
      const estimates = await estimateClaudeSessionLogTokenEstimates(env, now);
      const stats = _cacheStats();
      assert.equal(stats.files, 1);
      assert.equal(stats.hits, 1);
      assert.equal(stats.misses, 0);
      const rolling = estimates.find(
        (estimate) => estimate.periodId === "rolling_7d",
      );
      assert.equal(rolling.totalTokens, 110);
    },
  );
});

test("skips oversized lines and marks the estimate approximate", async () => {
  const now = fixedNoon();
  const recent = now - HOUR_MS;
  const oversizedLine =
    assistantLine(recent, {
      messageId: "msg-huge",
      input: 999_999,
      output: 999_999,
    }) + " ".repeat(4 * 1024 * 1024);
  await withClaudeConfigDir(
    {
      "session-1.jsonl": [
        assistantLine(recent, { messageId: "msg-ok", input: 100, output: 10 }),
        oversizedLine,
      ],
    },
    async (configDir) => {
      const env = { CLAUDE_CONFIG_DIR: configDir };
      const estimates = await estimateClaudeSessionLogTokenEstimates(env, now);
      const rolling = estimates.find(
        (estimate) => estimate.periodId === "rolling_7d",
      );
      assert.equal(rolling.totalTokens, 110);
      assert.equal(rolling.estimated, true);
      assert.match(rolling.assumption, /4MB/);
      assert.match(rolling.assumption, /approximate/);

      // The skipped-line count is cached with the file, so a warm scan must
      // still report the estimate as approximate.
      const warm = await estimateClaudeSessionLogTokenEstimates(env, now);
      assert.equal(_cacheStats().hits, 1);
      assert.deepEqual(warm, estimates);
    },
  );
});

test("reports needs_configuration when the projects directory is missing", async () => {
  const absentDir = join(tmpdir(), `usage-hub-absent-claude-${process.pid}`);
  assert.equal(claudeProjectsDir({ CLAUDE_CONFIG_DIR: absentDir }), join(absentDir, "projects"));

  const provider = await collectClaudeCodeUsage({ CLAUDE_CONFIG_DIR: absentDir });
  assert.equal(provider.id, "claude");
  assert.equal(provider.state, "needs_configuration");
  assert.match(provider.message, /Claude Code session logs not found/);
  assert.deepEqual(provider.windows, []);
  assert.equal(provider.balance, null);
  assert.equal(provider.tokenUsage, null);
  assert.deepEqual(provider.tokenEstimates, []);
});

test("reports ready with observed local tokens when session logs exist", async () => {
  const now = Date.now();
  const provider = await withClaudeConfigDir(
    {
      "session-1.jsonl": [
        assistantLine(now, {
          messageId: "msg-live",
          input: 120,
          cacheRead: 20,
          output: 30,
        }),
      ],
    },
    (configDir) => collectClaudeCodeUsage({ CLAUDE_CONFIG_DIR: configDir }),
  );

  assert.equal(provider.id, "claude");
  assert.equal(provider.name, "Claude Code");
  assert.equal(provider.shortName, "CL");
  assert.equal(provider.accent, "#D97757");
  assert.equal(provider.state, "ready");
  assert.equal(provider.message, null);
  assert.deepEqual(provider.windows, []);
  assert.equal(provider.balance, null);
  assert.equal(provider.tokenUsage.periodId, "today");
  assert.equal(provider.tokenUsage.totalTokens, 170);
  assert.deepEqual(
    provider.tokenEstimates.map((estimate) => estimate.periodId),
    ["today", "rolling_7d"],
  );
});

test("stays ready with an explanatory message when no recent usage exists", async () => {
  const provider = await withClaudeConfigDir(
    {},
    (configDir) => collectClaudeCodeUsage({ CLAUDE_CONFIG_DIR: configDir }),
  );

  assert.equal(provider.state, "ready");
  assert.match(provider.message, /No Claude Code token usage recorded/);
  assert.equal(provider.tokenUsage, null);
  assert.deepEqual(provider.tokenEstimates, []);
});
