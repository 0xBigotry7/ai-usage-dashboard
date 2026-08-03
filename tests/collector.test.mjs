import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeCodexUsage } from "../collector/providers/codex.mjs";
import { normalizeDeepSeekBalance } from "../collector/providers/deepseek.mjs";
import { normalizeGitHubCopilotUsage } from "../collector/providers/github-copilot.mjs";
import { normalizeKimiUsage } from "../collector/providers/kimi.mjs";
import { normalizeOpenAIAdminUsage } from "../collector/providers/openai-api.mjs";
import { normalizeOpenRouterUsage } from "../collector/providers/openrouter.mjs";
import { providerCatalog } from "../collector/providers/index.mjs";
import { createProviderRefreshCoordinator } from "../collector/provider-refresh.mjs";
import { estimateWeeklyQuotaTokens } from "../collector/quota-estimate.mjs";
import {
  mergeRemoteProviderRows,
  sanitizeRemoteSnapshot,
} from "../lib/remote-usage.ts";
import { estimateNextResetAt } from "../lib/reset-estimate.ts";
import { summarizeTokenCountRecords } from "../collector/session-log-estimate.mjs";
import {
  fetchJson,
  parseEnvAssignment,
  resolvePollIntervalMs,
} from "../collector/shared.mjs";
import { createHistoryStore, HistoryStore } from "../collector/history.mjs";

test("estimates a missing reset from the latest observed quota drop", () => {
  const resetsAt = estimateNextResetAt({
    providerId: "example-ai",
    windowId: "five_hour",
    durationSeconds: 18_000,
    now: Date.parse("2026-07-24T07:30:00.000Z"),
    history: [
      {
        providerId: "example-ai",
        windowId: "five_hour",
        usedPercent: 7,
        capturedAt: "2026-07-24T01:57:00.000Z",
      },
      {
        providerId: "example-ai",
        windowId: "five_hour",
        usedPercent: 0,
        capturedAt: "2026-07-24T02:30:00.000Z",
      },
    ],
  });

  assert.equal(resetsAt, "2026-07-24T12:13:30.000Z");
});

test("does not invent a reset when history never shows a quota drop", () => {
  const resetsAt = estimateNextResetAt({
    providerId: "example-ai",
    windowId: "weekly",
    durationSeconds: 604_800,
    history: [
      {
        providerId: "example-ai",
        windowId: "weekly",
        usedPercent: 11,
        capturedAt: "2026-07-23T01:00:00.000Z",
      },
      {
        providerId: "example-ai",
        windowId: "weekly",
        usedPercent: 13,
        capturedAt: "2026-07-24T01:00:00.000Z",
      },
    ],
  });

  assert.equal(resetsAt, null);
});

test("normalizes a weekly-only Codex response without inventing a 5-hour window", () => {
  const result = normalizeCodexUsage({
    plan_type: "prolite",
    rate_limit: {
      primary_window: {
        used_percent: 12,
        limit_window_seconds: 604800,
        reset_at: 1785335055,
      },
      secondary_window: null,
    },
    credits: { balance: "2500" },
  });

  assert.equal(result.state, "ready");
  assert.equal(result.plan, "Pro Lite");
  assert.deepEqual(result.windows.map((window) => window.id), ["weekly"]);
  assert.equal(result.windows[0].usedPercent, 12);
  assert.equal(result.balance.value, 2500);
});

test("normalizes Kimi weekly and five-hour server windows", () => {
  const result = normalizeKimiUsage({
    usage: {
      limit: "100",
      used: "39",
      remaining: "61",
      resetTime: "2026-07-25T09:00:03.200931Z",
    },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: {
          limit: "100",
          used: "10",
          remaining: "90",
          resetTime: "2026-07-23T19:00:03.200931Z",
        },
      },
    ],
  });

  assert.deepEqual(
    result.windows.map((window) => window.id),
    ["five_hour", "weekly"],
  );
  assert.equal(result.windows[0].usedPercent, 10);
  assert.equal(result.windows[1].usedPercent, 39);
});

test("normalizes official OpenAI organization usage by model", () => {
  const result = normalizeOpenAIAdminUsage({
    data: [
      {
        results: [
          {
            model: "gpt-example",
            input_tokens: 1_200,
            output_tokens: 300,
            input_audio_tokens: 20,
            output_audio_tokens: 10,
            num_model_requests: 4,
          },
          {
            model: "gpt-example-mini",
            input_tokens: 500,
            output_tokens: 100,
            num_model_requests: 2,
          },
        ],
      },
    ],
  });

  assert.equal(result.state, "ready");
  assert.equal(result.tokenUsage.basis, "api_usage");
  assert.equal(result.tokenUsage.estimated, false);
  assert.equal(result.tokenUsage.totalTokens, 2_100);
  assert.equal(result.tokenUsage.requestCount, 6);
  assert.deepEqual(
    result.tokenUsage.models.map((model) => [
      model.id,
      model.estimatedTokens,
      model.requestCount,
    ]),
    [
      ["gpt-example", 1_500, 4],
      ["gpt-example-mini", 600, 2],
    ],
  );
});

test("normalizes OpenRouter key limits for the platform reset period", () => {
  const result = normalizeOpenRouterUsage({
    data: {
      label: "dashboard",
      is_free_tier: false,
      limit: 50,
      limit_remaining: 37.5,
      limit_reset: "weekly",
      usage_weekly: 12.5,
    },
  });

  assert.equal(result.windows[0].id, "weekly");
  assert.equal(result.windows[0].usedPercent, 25);
  assert.equal(result.balance.value, 37.5);
  assert.equal(result.balance.unit, "USD");
});

test("normalizes DeepSeek balance without inventing a quota window", () => {
  const result = normalizeDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "110.00" },
      { currency: "USD", total_balance: "8.50" },
    ],
  });

  assert.equal(result.state, "ready");
  assert.deepEqual(result.windows, []);
  assert.equal(result.balance.value, 110);
  assert.equal(result.balance.unit, "CNY");
  assert.match(result.message, /CNY \/ USD/);
});

test("normalizes GitHub Copilot AI Credits with an optional monthly limit", () => {
  const result = normalizeGitHubCopilotUsage(
    {
      usageItems: [
        {
          product: "Copilot AI Credits",
          model: "GPT-5",
          grossQuantity: 80,
        },
        {
          product: "Copilot AI Credits",
          model: "GPT-5 mini",
          netQuantity: 20,
        },
      ],
    },
    { monthlyLimit: 200 },
  );

  assert.equal(result.windows[0].id, "monthly");
  assert.equal(result.windows[0].usedPercent, 50);
  assert.equal(result.balance.value, 100);
  assert.match(result.message, /GPT-5 80/);
});

test("enables optional providers only after their local configuration exists", () => {
  // Pin CLAUDE_CONFIG_DIR to an absent path so the catalog does not depend on
  // whether the machine running the tests has Claude Code installed.
  const absentClaudeDir = join(tmpdir(), `usage-hub-absent-claude-${process.pid}`);
  const defaultCatalog = providerCatalog({ CLAUDE_CONFIG_DIR: absentClaudeDir });
  assert.deepEqual(
    defaultCatalog.filter((provider) => provider.enabled).map(({ id }) => id),
    ["codex", "kimi"],
  );

  const configuredCatalog = providerCatalog({
    CLAUDE_CONFIG_DIR: absentClaudeDir,
    OPENROUTER_API_KEY: "synthetic-key",
    DEEPSEEK_API_KEY: "synthetic-key",
  });
  assert.deepEqual(
    configuredCatalog
      .filter((provider) => provider.enabled)
      .map(({ id }) => id),
    ["codex", "kimi", "openrouter", "deepseek"],
  );

  const claudeConfigDir = mkdtempSync(join(tmpdir(), "usage-hub-claude-"));
  try {
    mkdirSync(join(claudeConfigDir, "projects"), { recursive: true });
    const claudeCatalog = providerCatalog({ CLAUDE_CONFIG_DIR: claudeConfigDir });
    assert.deepEqual(
      claudeCatalog.filter((provider) => provider.enabled).map(({ id }) => id),
      ["codex", "claude", "kimi"],
    );
  } finally {
    rmSync(claudeConfigDir, { recursive: true, force: true });
  }
});

function syntheticProvider({
  state = "ready",
  updatedAt = "2026-07-30T08:00:00.000Z",
  message = null,
} = {}) {
  return {
    id: "synthetic",
    name: "Synthetic AI",
    shortName: "SY",
    accent: "#7bf1a8",
    state,
    plan: "Test",
    source: "Synthetic API",
    updatedAt,
    windows:
      state === "ready"
        ? [
            {
              id: "weekly",
              label: "本周",
              durationSeconds: 604_800,
              usedPercent: 42,
              used: null,
              limit: null,
              remaining: null,
              resetsAt: null,
            },
          ]
        : [],
    balance: null,
    message,
    tokenUsage:
      state === "ready"
        ? {
            basis: "quota_percentage",
            estimated: true,
            totalTokens: 4_200_000,
            models: [],
          }
        : null,
  };
}

test("provider refresh coordinator reuses ready data until five minutes pass", async () => {
  let now = Date.parse("2026-07-30T08:00:00.000Z");
  let calls = 0;
  const coordinator = createProviderRefreshCoordinator({
    now: () => now,
    wait: async () => {},
  });
  const adapter = {
    id: "synthetic",
    name: "Synthetic AI",
    collect: async () => {
      calls += 1;
      return syntheticProvider();
    },
  };

  const first = await coordinator.collect([adapter], {});
  now += 60_000;
  const cached = await coordinator.collect([adapter], {});
  now += 4 * 60_000;
  const refreshed = await coordinator.collect([adapter], {});

  assert.equal(first[0].state, "ready");
  assert.equal(cached[0].state, "ready");
  assert.equal(refreshed[0].state, "ready");
  assert.equal(calls, 2);
});

test("provider refresh coordinator retries one transient failure before degrading", async () => {
  let now = Date.parse("2026-07-30T08:00:00.000Z");
  let calls = 0;
  const waits = [];
  const coordinator = createProviderRefreshCoordinator({
    now: () => now,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });
  const adapter = {
    id: "synthetic",
    name: "Synthetic AI",
    collect: async () => {
      calls += 1;
      if (calls === 2) {
        return syntheticProvider({
          state: "error",
          updatedAt: new Date(now).toISOString(),
          message: "连接超时（UND_ERR_CONNECT_TIMEOUT）",
        });
      }
      return syntheticProvider({
        updatedAt: new Date(now).toISOString(),
      });
    },
  };

  await coordinator.collect([adapter], {});
  now += 5 * 60_000;
  const recovered = await coordinator.collect([adapter], {});

  assert.equal(recovered[0].state, "ready");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [3_000]);
});

test("provider refresh coordinator keeps last-good data through two failed cycles", async () => {
  let now = Date.parse("2026-07-30T08:00:00.000Z");
  let calls = 0;
  const coordinator = createProviderRefreshCoordinator({
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });
  const adapter = {
    id: "synthetic",
    name: "Synthetic AI",
    collect: async () => {
      calls += 1;
      if (calls === 1) return syntheticProvider();
      return syntheticProvider({
        state: "error",
        updatedAt: new Date(now).toISOString(),
        message: "fetch failed（ECONNRESET）",
      });
    },
  };

  const initial = await coordinator.collect([adapter], {});
  now += 5 * 60_000;
  const firstFailure = await coordinator.collect([adapter], {});
  now += 60_000;
  const duringBackoff = await coordinator.collect([adapter], {});
  now += 60_000;
  const secondFailure = await coordinator.collect([adapter], {});

  assert.equal(firstFailure[0].state, "ready");
  assert.equal(firstFailure[0].updatedAt, initial[0].updatedAt);
  assert.equal(firstFailure[0].windows[0].usedPercent, 42);
  assert.equal(firstFailure[0].tokenUsage.totalTokens, 4_200_000);
  assert.match(firstFailure[0].message, /旧数据 · 重试中/);
  assert.equal(duringBackoff[0], firstFailure[0]);
  assert.equal(secondFailure[0].state, "ready");
  assert.equal(calls, 5);
});

test("provider refresh coordinator shows a transient error on the third failed cycle", async () => {
  let now = Date.parse("2026-07-30T08:00:00.000Z");
  let calls = 0;
  const coordinator = createProviderRefreshCoordinator({
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  });
  const adapter = {
    id: "synthetic",
    name: "Synthetic AI",
    collect: async () => {
      calls += 1;
      if (calls === 1) return syntheticProvider();
      return syntheticProvider({
        state: "error",
        updatedAt: new Date(now).toISOString(),
        message: "HTTP 429",
      });
    },
  };

  await coordinator.collect([adapter], {});
  now += 5 * 60_000;
  await coordinator.collect([adapter], {});
  now += 2 * 60_000;
  await coordinator.collect([adapter], {});
  now += 5 * 60_000;
  const thirdFailure = await coordinator.collect([adapter], {});

  assert.equal(thirdFailure[0].state, "error");
  assert.equal(thirdFailure[0].message, "HTTP 429");
  assert.equal(calls, 7);
});

test("provider refresh coordinator exposes auth errors immediately without retry", async () => {
  let now = Date.parse("2026-07-30T08:00:00.000Z");
  let calls = 0;
  let waits = 0;
  const coordinator = createProviderRefreshCoordinator({
    now: () => now,
    wait: async () => {
      waits += 1;
    },
  });
  const adapter = {
    id: "synthetic",
    name: "Synthetic AI",
    collect: async () => {
      calls += 1;
      if (calls === 1) return syntheticProvider();
      return syntheticProvider({
        state: "auth_error",
        updatedAt: new Date(now).toISOString(),
        message: "登录已失效",
      });
    },
  };

  await coordinator.collect([adapter], {});
  now += 5 * 60_000;
  const authError = await coordinator.collect([adapter], {});

  assert.equal(authError[0].state, "auth_error");
  assert.equal(authError[0].message, "登录已失效");
  assert.equal(calls, 2);
  assert.equal(waits, 0);
});

test("provider refresh coordinator manual refresh respects the normal interval", async () => {
  let now = Date.parse("2026-07-30T08:00:00.000Z");
  let calls = 0;
  const coordinator = createProviderRefreshCoordinator({
    now: () => now,
    wait: async () => {},
  });
  const adapter = {
    id: "synthetic",
    name: "Synthetic AI",
    collect: async () => {
      calls += 1;
      return syntheticProvider({
        updatedAt: new Date(now).toISOString(),
      });
    },
  };

  await coordinator.collect([adapter], {});
  now += 60_000;
  await coordinator.collect([adapter], {}, { force: true });

  assert.equal(calls, 1);
});

test("provider refresh coordinator allows one immediate auth recovery attempt", async () => {
  let now = Date.now();
  let calls = 0;
  const coordinator = createProviderRefreshCoordinator({
    now: () => now,
    wait: async () => {},
  });
  const adapter = {
    id: "synthetic",
    name: "Synthetic AI",
    collect: async () => {
      calls += 1;
      if (calls === 1) {
        return syntheticProvider({
          state: "auth_error",
          updatedAt: new Date(now).toISOString(),
          message: "登录已失效",
        });
      }
      return syntheticProvider({
        updatedAt: new Date(now).toISOString(),
      });
    },
  };

  const authError = await coordinator.collect([adapter], {});
  now += 60_000;
  const recovered = await coordinator.collect([adapter], {}, { force: true });

  assert.equal(authError[0].state, "auth_error");
  assert.equal(recovered[0].state, "ready");
  assert.equal(calls, 2);
});

test("provider refresh coordinator limits repeated manual auth attempts", async () => {
  let now = Date.now();
  let calls = 0;
  const coordinator = createProviderRefreshCoordinator({
    now: () => now,
    wait: async () => {},
  });
  const adapter = {
    id: "synthetic",
    name: "Synthetic AI",
    collect: async () => {
      calls += 1;
      return syntheticProvider({
        state: "auth_error",
        updatedAt: new Date(now).toISOString(),
        message: "登录已失效",
      });
    },
  };

  await coordinator.collect([adapter], {});
  now += 60_000;
  await coordinator.collect([adapter], {}, { force: true });
  now += 60_000;
  const cooledDown = await coordinator.collect(
    [adapter],
    {},
    { force: true },
  );

  assert.equal(cooledDown[0].state, "auth_error");
  assert.equal(calls, 2);
});

test("fetchJson exposes the safe low-level connection error code", async () => {
  const originalFetch = globalThis.fetch;
  const cause = Object.assign(new Error("socket reset"), {
    code: "ECONNRESET",
  });
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", { cause });
  };

  try {
    await assert.rejects(
      fetchJson("https://example.invalid/usage"),
      /连接被重置（ECONNRESET）/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("history records cached last-good data at its original observation time", () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-history-test-"));
  const history = new HistoryStore(join(directory, "history.db"));
  const capturedAt = new Date();
  const observedAt = new Date(
    capturedAt.getTime() - 30 * 60_000,
  ).toISOString();
  const futureAt = new Date(
    capturedAt.getTime() + 30 * 60_000,
  ).toISOString();

  try {
    history.save(
      [syntheticProvider({ updatedAt: observedAt })],
      capturedAt,
    );
    history.save(
      [
        syntheticProvider({
          updatedAt: futureAt,
        }),
      ],
      capturedAt,
    );
    const rows = history.recent(24);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].capturedAt, observedAt);
    assert.equal(rows[1].capturedAt, capturedAt.toISOString());
  } finally {
    history.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolves the poll interval with a fallback for unparseable values", () => {
  assert.equal(resolvePollIntervalMs("120000"), 120_000);
  // "5m" is not a number; it must fall back instead of poisoning
  // setInterval with NaN (which Node treats as a 1ms hot loop).
  assert.equal(resolvePollIntervalMs("5m"), 60_000);
  assert.equal(resolvePollIntervalMs(undefined), 60_000);
  assert.equal(resolvePollIntervalMs(""), 60_000);
  assert.equal(resolvePollIntervalMs("1000"), 30_000);
  assert.equal(resolvePollIntervalMs("30000"), 30_000);
});

test("parses private env lines including export-prefixed assignments", () => {
  assert.deepEqual(parseEnvAssignment("KIMI_CODE_API_KEY=abc"), {
    key: "KIMI_CODE_API_KEY",
    value: "abc",
  });
  assert.deepEqual(parseEnvAssignment("export KIMI_CODE_API_KEY=abc"), {
    key: "KIMI_CODE_API_KEY",
    value: "abc",
  });
  assert.deepEqual(
    parseEnvAssignment('  export OPENROUTER_API_KEY="quoted value"  '),
    { key: "OPENROUTER_API_KEY", value: "quoted value" },
  );
  assert.deepEqual(parseEnvAssignment("DEEPSEEK_API_KEY='single'"), {
    key: "DEEPSEEK_API_KEY",
    value: "single",
  });
  assert.equal(parseEnvAssignment("# a comment"), null);
  assert.equal(parseEnvAssignment(""), null);
  assert.equal(parseEnvAssignment("=missing-key"), null);
  assert.equal(parseEnvAssignment("no assignment here"), null);
});

test("createHistoryStore returns a working store for a healthy database path", () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-history-safe-test-"));
  const store = createHistoryStore(join(directory, "history.db"));
  try {
    assert.ok(store instanceof HistoryStore);
    store.save(
      [syntheticProvider({ updatedAt: new Date().toISOString() })],
      new Date(),
    );
    assert.equal(store.recent(24).length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("createHistoryStore falls back to a no-op store on a corrupt database", () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-history-corrupt-test-"));
  const corruptPath = join(directory, "corrupt.db");
  writeFileSync(corruptPath, "this is definitely not a sqlite database");
  try {
    const store = createHistoryStore(corruptPath);
    assert.equal(store instanceof HistoryStore, false);
    // The stub must keep the collector alive: writes are dropped and
    // reads come back empty instead of throwing.
    store.save([syntheticProvider()], new Date());
    assert.deepEqual(store.recent(24), []);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("estimates weekly token equivalents without double-counting scoped models", () => {
  const result = estimateWeeklyQuotaTokens(
    [
      { id: "five_hour", usedPercent: 80 },
      { id: "weekly", usedPercent: 25 },
      { id: "weekly_reasoning", usedPercent: 40 },
    ],
    {
      id: "example-subscription",
      label: "Example AI 综合订阅",
      capacityTokens: 10_000_000,
      scopedModels: [
        {
          id: "example-reasoning-model",
          label: "Reasoning 模型独立额度",
          windowId: "weekly_reasoning",
          capacityTokens: 5_000_000,
        },
      ],
    },
  );

  assert.equal(result.totalTokens, 2_500_000);
  assert.equal(result.models[1].estimatedTokens, 2_000_000);
  assert.equal(result.models[1].countedInTotal, false);
});

test("sums Codex token_count deltas without double-counting cumulative events", () => {
  const sinceMs = Date.parse("2026-07-20T00:00:00.000Z");
  const result = summarizeTokenCountRecords(
    [
      {
        sessionId: "session-a",
        timestamp: Date.parse("2026-07-19T23:00:00.000Z"),
        totalTokens: 100,
        model: "gpt-example",
      },
      {
        sessionId: "session-a",
        timestamp: Date.parse("2026-07-20T01:00:00.000Z"),
        totalTokens: 160,
        lastTokens: 60,
        model: "gpt-example",
      },
      {
        sessionId: "session-a",
        timestamp: Date.parse("2026-07-20T02:00:00.000Z"),
        totalTokens: 210,
        lastTokens: 50,
        model: "gpt-example",
      },
      {
        sessionId: "session-b",
        timestamp: Date.parse("2026-07-20T03:00:00.000Z"),
        totalTokens: 40,
        lastTokens: 40,
        model: "gpt-example-mini",
      },
    ],
    sinceMs,
  );

  assert.equal(result.totalTokens, 150);
  assert.equal(result.sessionCount, 2);
  assert.deepEqual(
    result.models.map((model) => [model.label, model.estimatedTokens]),
    [
      ["gpt-example", 110],
      ["gpt-example-mini", 40],
    ],
  );
});

test("remote snapshot whitelist strips credentials and local host details", () => {
  const snapshot = sanitizeRemoteSnapshot({
    generatedAt: "2026-07-24T01:00:00.000Z",
    collector: {
      version: "0.1.0",
      state: "online",
      host: "private-host.local",
      access_token: "must-not-leave-the-mac",
    },
    providers: [
      {
        id: "kimi",
        name: "Kimi Code",
        shortName: "KM",
        accent: "#b7c8ff",
        state: "ready",
        plan: "Kimi Code",
        source: "Kimi Code API Key",
        sourceKind: "api_key",
        host: "private-host.local",
        apiKey: "must-not-leave-the-mac",
        updatedAt: "2026-07-24T01:00:00.000Z",
        windows: [
          {
            id: "five_hour",
            label: "5 小时",
            durationSeconds: 18000,
            usedPercent: 21,
            used: 21,
            limit: 100,
            remaining: 79,
            resetsAt: "2026-07-24T03:00:00.000Z",
            token: "must-not-leave-the-mac",
          },
        ],
        tokenUsage: {
          basis: "quota_percentage",
          estimated: true,
          totalTokens: 2_100_000,
          capacityTokens: 10_000_000,
          usedPercent: 21,
          windowId: "weekly",
          models: [
            {
              id: "kimi-code-subscription",
              label: "Kimi Code 综合订阅",
              windowId: "weekly",
              usedPercent: 21,
              capacityTokens: 10_000_000,
              estimatedTokens: 2_100_000,
              countedInTotal: true,
              secretPath: "/private/must-not-leave-the-mac",
            },
          ],
          rawLog: "must-not-leave-the-mac",
        },
        tokenEstimates: [
          {
            basis: "session_logs",
            periodId: "today",
            scope: "local_device",
            estimated: false,
            totalTokens: 345_000,
            inputTokens: 330_000,
            cachedInputTokens: 120_500,
            outputTokens: 15_000,
            reasoningOutputTokens: 4_500,
            periodSeconds: 604_800,
            periodStartAt: "2026-07-18T01:00:00.000Z",
            sessionCount: 8,
            models: [
              {
                id: "codex-log-gpt-example",
                label: "gpt-example",
                estimatedTokens: 345_000,
                inputTokens: 330_000,
                cachedInputTokens: 120_500,
                outputTokens: 15_000,
                reasoningOutputTokens: 4_500,
                countedInTotal: true,
                rawEvent: "must-not-leave-the-mac",
              },
            ],
            assumption: "Synthetic fixture",
            localPath: "/private/must-not-leave-the-mac",
          },
          {
            basis: "api_usage",
            periodId: "rolling_7d",
            scope: "account",
            estimated: false,
            totalTokens: 98_000,
            inputTokens: 90_000,
            outputTokens: 8_000,
            periodSeconds: 604_800,
            periodStartAt: "2026-07-18T01:00:00.000Z",
            cachedInputTokens: 30_000,
            requestCount: 17,
            models: [
              {
                id: "gpt-example",
                label: "gpt-example",
                estimatedTokens: 98_000,
                inputTokens: 90_000,
                outputTokens: 8_000,
                requestCount: 17,
                countedInTotal: true,
                rawRequestId: "must-not-leave-the-mac",
              },
            ],
            assumption: "Synthetic official usage fixture",
            adminKey: "must-not-leave-the-mac",
          },
        ],
      },
    ],
  });

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /access_token|apiKey|private-host|must-not/);
  assert.equal(snapshot.providers[0].windows[0].usedPercent, 21);
  assert.equal(
    snapshot.providers[0].tokenUsage.models[0].estimatedTokens,
    2_100_000,
  );
  assert.equal(
    snapshot.providers[0].tokenEstimates[0].basis,
    "session_logs",
  );
  assert.equal(snapshot.providers[0].tokenEstimates[0].sessionCount, 8);
  assert.equal(snapshot.providers[0].tokenEstimates[0].periodId, "today");
  assert.equal(snapshot.providers[0].tokenEstimates[0].scope, "local_device");
  assert.equal(snapshot.providers[0].tokenEstimates[0].estimated, false);
  assert.equal(snapshot.providers[0].tokenEstimates[0].inputTokens, 330_000);
  assert.equal(snapshot.providers[0].tokenEstimates[0].outputTokens, 15_000);
  assert.equal(
    snapshot.providers[0].tokenEstimates[0].reasoningOutputTokens,
    4_500,
  );
  assert.equal(
    snapshot.providers[0].tokenEstimates[0].cachedInputTokens,
    120_500,
  );
  assert.equal(
    snapshot.providers[0].tokenEstimates[0].periodStartAt,
    "2026-07-18T01:00:00.000Z",
  );
  assert.equal(
    snapshot.providers[0].tokenEstimates[0].models[0].cachedInputTokens,
    120_500,
  );
  assert.equal(
    snapshot.providers[0].tokenEstimates[0].models[0].inputTokens,
    330_000,
  );
  assert.equal(
    snapshot.providers[0].tokenEstimates[0].models[0].outputTokens,
    15_000,
  );
  assert.equal(snapshot.providers[0].tokenEstimates[1].basis, "api_usage");
  assert.equal(snapshot.providers[0].tokenEstimates[1].periodId, "rolling_7d");
  assert.equal(snapshot.providers[0].tokenEstimates[1].scope, "account");
  assert.equal(snapshot.providers[0].tokenEstimates[1].estimated, false);
  assert.equal(snapshot.providers[0].tokenEstimates[1].inputTokens, 90_000);
  assert.equal(snapshot.providers[0].tokenEstimates[1].outputTokens, 8_000);
  assert.equal(snapshot.providers[0].tokenEstimates[1].requestCount, 17);
  // session_logs-only fields stay out of the api_usage branch entirely.
  assert.equal(
    snapshot.providers[0].tokenEstimates[1].cachedInputTokens,
    undefined,
  );
  assert.equal(
    snapshot.providers[0].tokenEstimates[1].periodStartAt,
    undefined,
  );
  assert.equal(snapshot.collector.syncMode, "sanitized-push");
});

test("remote snapshot bounds session_logs cached-token and period fields", () => {
  const snapshot = sanitizeRemoteSnapshot({
    providers: [
      {
        id: "codex",
        name: "OpenAI Codex",
        state: "ready",
        updatedAt: "2026-07-24T01:00:00.000Z",
        windows: [],
        tokenEstimates: [
          {
            basis: "session_logs",
            periodId: "not-a-period",
            scope: "not-a-scope",
            estimated: true,
            totalTokens: 100,
            cachedInputTokens: "not-a-number",
            periodSeconds: 604_800,
            periodStartAt: "not-a-date",
            sessionCount: 1,
            models: [
              {
                id: "codex-log-gpt-example",
                label: "gpt-example",
                estimatedTokens: 100,
                cachedInputTokens: -5,
                countedInTotal: true,
              },
            ],
          },
        ],
      },
    ],
  });

  const estimate = snapshot.providers[0].tokenEstimates[0];
  assert.equal(estimate.cachedInputTokens, undefined);
  assert.equal(estimate.periodStartAt, null);
  assert.equal(estimate.periodId, "weekly_cycle");
  assert.equal(estimate.scope, "local_device");
  assert.equal(estimate.models[0].cachedInputTokens, 0);
});

test("remote snapshot does not invent zero-valued token breakdowns", () => {
  const snapshot = sanitizeRemoteSnapshot({
    providers: [
      {
        id: "codex",
        name: "OpenAI Codex",
        state: "ready",
        updatedAt: "2026-07-26T12:00:00.000Z",
        windows: [],
        tokenEstimates: [
          {
            basis: "session_logs",
            periodId: "weekly_cycle",
            scope: "local_device",
            estimated: true,
            totalTokens: 123_456,
            models: [
              {
                id: "codex-log-gpt-example",
                label: "gpt-example",
                estimatedTokens: 123_456,
                countedInTotal: true,
              },
            ],
            assumption: "Legacy total-only record.",
          },
        ],
      },
    ],
  });

  const estimate = snapshot.providers[0].tokenEstimates[0];
  assert.equal(estimate.totalTokens, 123_456);
  assert.equal("inputTokens" in estimate, false);
  assert.equal("outputTokens" in estimate, false);
  assert.equal("cachedInputTokens" in estimate, false);
  assert.equal("inputTokens" in estimate.models[0], false);
  assert.equal("outputTokens" in estimate.models[0], false);
});

test("merges independently pushed provider rows without exposing legacy payloads", () => {
  const rows = [
    {
      id: "example-ai",
      payload: JSON.stringify({
        id: "example-ai",
        name: "Example AI",
        shortName: "EA",
        accent: "#d89574",
        state: "ready",
        plan: "Max",
        source: "Custom collector",
        sourceKind: "custom",
        updatedAt: "2026-07-24T02:00:00.000Z",
        windows: [
          {
            id: "five_hour",
            label: "5 小时",
            durationSeconds: 18000,
            usedPercent: 14,
            resetsAt: "2026-07-24T05:00:00.000Z",
          },
        ],
        accessToken: "must-not-appear",
      }),
      generatedAt: "2026-07-24T02:00:00.000Z",
      receivedAt: "2026-07-24T02:00:01.000Z",
    },
    {
      id: "codex",
      payload: JSON.stringify({
        id: "codex",
        name: "OpenAI Codex",
        state: "ready",
        updatedAt: "2026-07-24T01:59:00.000Z",
        windows: [],
      }),
      generatedAt: "2026-07-24T01:59:00.000Z",
      receivedAt: "2026-07-24T01:59:01.000Z",
    },
    {
      id: "latest",
      payload: JSON.stringify({ secret: "legacy-must-not-appear" }),
      generatedAt: "2026-07-23T01:00:00.000Z",
      receivedAt: "2026-07-23T01:00:01.000Z",
    },
  ];

  const merged = mergeRemoteProviderRows(rows);
  assert.deepEqual(
    merged.providers.map((provider) => provider.id),
    ["codex", "example-ai"],
  );
  assert.equal(merged.collector.version, "0.8.3");
  assert.equal(merged.collector.syncMode, "multi-host-sanitized-push");
  assert.doesNotMatch(JSON.stringify(merged), /must-not-appear|accessToken/);
});

test("drops malformed remote balances instead of emitting a null numeric value", () => {
  const snapshot = sanitizeRemoteSnapshot({
    collector: {
      host: "private-host.local",
      version: "0.7.0",
      state: "online",
    },
    providers: [
      {
        id: "example-ai",
        name: "Example AI",
        shortName: "EA",
        accent: "#d89574",
        state: "ready",
        source: "Custom collector",
        updatedAt: "2026-07-24T02:00:00.000Z",
        windows: [],
        balance: {
          label: "余额",
          value: "not-a-number",
          unit: "USD",
        },
      },
    ],
  });

  assert.equal(snapshot.providers[0].balance, null);
});
