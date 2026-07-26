import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexUsage } from "../collector/providers/codex.mjs";
import { normalizeDeepSeekBalance } from "../collector/providers/deepseek.mjs";
import { normalizeGitHubCopilotUsage } from "../collector/providers/github-copilot.mjs";
import { normalizeKimiUsage } from "../collector/providers/kimi.mjs";
import { normalizeOpenAIAdminUsage } from "../collector/providers/openai-api.mjs";
import { normalizeOpenRouterUsage } from "../collector/providers/openrouter.mjs";
import { providerCatalog } from "../collector/providers/index.mjs";
import { estimateWeeklyQuotaTokens } from "../collector/quota-estimate.mjs";
import {
  mergeRemoteProviderRows,
  sanitizeRemoteSnapshot,
} from "../lib/remote-usage.ts";
import { estimateNextResetAt } from "../lib/reset-estimate.ts";
import { summarizeTokenCountRecords } from "../collector/session-log-estimate.mjs";

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
  assert.equal(result.tokenUsage.totalTokens, 2_130);
  assert.equal(result.tokenUsage.requestCount, 6);
  assert.deepEqual(
    result.tokenUsage.models.map((model) => [
      model.id,
      model.estimatedTokens,
      model.requestCount,
    ]),
    [
      ["gpt-example", 1_530, 4],
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
  const defaultCatalog = providerCatalog({});
  assert.deepEqual(
    defaultCatalog.filter((provider) => provider.enabled).map(({ id }) => id),
    ["codex", "kimi"],
  );

  const configuredCatalog = providerCatalog({
    OPENROUTER_API_KEY: "synthetic-key",
    DEEPSEEK_API_KEY: "synthetic-key",
  });
  assert.deepEqual(
    configuredCatalog
      .filter((provider) => provider.enabled)
      .map(({ id }) => id),
    ["codex", "kimi", "openrouter", "deepseek"],
  );
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
            estimated: true,
            totalTokens: 345_000,
            periodSeconds: 604_800,
            sessionCount: 8,
            models: [
              {
                id: "codex-log-gpt-example",
                label: "gpt-example",
                estimatedTokens: 345_000,
                countedInTotal: true,
                rawEvent: "must-not-leave-the-mac",
              },
            ],
            assumption: "Synthetic fixture",
            localPath: "/private/must-not-leave-the-mac",
          },
          {
            basis: "api_usage",
            estimated: false,
            totalTokens: 98_000,
            periodSeconds: 604_800,
            requestCount: 17,
            models: [
              {
                id: "gpt-example",
                label: "gpt-example",
                estimatedTokens: 98_000,
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
  assert.equal(snapshot.providers[0].tokenEstimates[1].basis, "api_usage");
  assert.equal(snapshot.providers[0].tokenEstimates[1].estimated, false);
  assert.equal(snapshot.providers[0].tokenEstimates[1].requestCount, 17);
  assert.equal(snapshot.collector.syncMode, "sanitized-push");
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
  assert.equal(merged.collector.version, "0.8.0");
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
