import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { normalizeAntigravityUsage } from "../collector/providers/antigravity.mjs";
import {
  collectCursorUsage,
  collectGrokBotUsage,
  normalizeCursorUsage,
  normalizeGrokBotUsage,
} from "../collector/providers/cursor.mjs";
import { collectDeepSeekBalance } from "../collector/providers/deepseek.mjs";
import { collectGitHubCopilotUsage } from "../collector/providers/github-copilot.mjs";
import { groupGrokSharedUsage, normalizeGrokBilling } from "../collector/providers/grok.mjs";
import { collectKimiUsage } from "../collector/providers/kimi.mjs";
import { collectOpenAIAdminUsage } from "../collector/providers/openai-api.mjs";
import { collectOpenRouterUsage } from "../collector/providers/openrouter.mjs";

function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(url, options);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Grok groups only matching shared weeks and retains each source reading", () => {
  const start = "2030-01-01T00:00:00.000Z";
  const end = "2030-01-08T00:00:00.000Z";
  const now = Date.parse("2030-01-03T00:00:00Z");
  const build = normalizeGrokBilling({ config: {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
    creditUsagePercent: 1,
    isUnifiedBillingUser: true,
  } });
  const bot = {
    ...normalizeGrokBotUsage({ currentPeriodStart: start, nextResetTimestampUtc: end, usagePercent: 0.1234, isUnified: true }),
    cursorAccount: "current-account",
  };
  const cursor = {
    ...normalizeCursorUsage({ individualUsage: { plan: { totalPercentUsed: 42 } } }),
    cursorAccount: "current-account",
  };
  const grouped = groupGrokSharedUsage([build, bot, cursor], now);
  assert.deepEqual(grouped.map(({ id }) => id), ["grok", "cursor"]);
  assert.equal(grouped[0].windows[0].usedPercent, 1);
  assert.equal(grouped[0].windows[0].resetsAt, end);
  assert.deepEqual(grouped[0].readings.map(({ id, windows }) => [id, windows[0].usedPercent]), [
    ["grok", 1], ["grok-bot", 0.1234],
  ]);

  const switched = groupGrokSharedUsage([build, bot, { ...cursor, cursorAccount: "another-account" }], now);
  assert.deepEqual(switched.map(({ id }) => id), ["grok", "cursor"]);
  const otherWeek = { ...bot, sharedWeekStart: "2030-01-02T00:00:00.000Z" };
  assert.deepEqual(groupGrokSharedUsage([build, otherWeek, cursor], now), [build, otherWeek, cursor]);
  assert.deepEqual(groupGrokSharedUsage([build, bot, cursor], Date.parse(end)), [build, bot, cursor]);
});

test("Cursor reports an encrypted desktop sign-in as unreadable, not as signed out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-hub-cursor-"));
  const path = join(dir, "state.vscdb");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  const save = db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('cursorAuth/accessToken', ?)");
  const env = { USAGE_HUB_CURSOR_DB: path };

  save.run("0123456789abcdef012:v1:c2FtcGxlIGNpcGhlcnRleHQ=");
  const cursor = await collectCursorUsage(env);
  assert.equal(cursor.state, "error");
  assert.equal(cursor.retryable, false);
  assert.match(cursor.message, /encrypted on this Mac/);
  const bot = await collectGrokBotUsage(env);
  assert.equal(bot.state, "error");
  assert.match(bot.message, /encrypted on this Mac.*Grok card still counts/);

  // A missing or lapsed sign-in is still the user's to fix in Cursor.
  save.run("");
  assert.equal((await collectCursorUsage(env)).state, "auth_error");
  const expired = ["e30", Buffer.from(JSON.stringify({ sub: "auth0|sample", exp: 1 })).toString("base64url"), "sig"].join(".");
  save.run(expired);
  assert.equal((await collectCursorUsage(env)).state, "auth_error");
  db.close();
  assert.equal((await collectCursorUsage({ USAGE_HUB_CURSOR_DB: join(dir, "missing.vscdb") })).state, "auth_error");
});

test("Antigravity rounds its percentages and only notes a missing reset when one is missing", () => {
  const capturedAt = "2030-01-01T00:00:00.000Z";
  const active = { id: "gemini-weekly", remainingFraction: 0.879712, resetTime: "2030-01-06T00:00:00Z" };
  const used = normalizeAntigravityUsage({ capturedAt, windows: [active] });
  assert.equal(used.windows[0].usedPercent, 12);
  assert.equal(used.updatedAt, capturedAt);
  assert.equal(used.message, null);
  const untouched = normalizeAntigravityUsage({
    capturedAt,
    windows: [active, { id: "3p-weekly", remainingFraction: 1, resetTime: "2030-01-08T00:00:00Z" }],
  });
  assert.deepEqual(untouched.windows.map(({ id, resetsAt }) => [id, resetsAt]), [
    ["3p_weekly", null], ["gemini_weekly", "2030-01-06T00:00:00.000Z"],
  ]);
  assert.match(untouched.message, /no active reset/);
});

test("github copilot adapter sends a real published GitHub API version", async () => {
  const mock = mockFetch(() => jsonResponse(200, { usageItems: [] }));
  try {
    const result = await collectGitHubCopilotUsage({
      GITHUB_COPILOT_TOKEN: "synthetic-token",
      GITHUB_COPILOT_USERNAME: "octocat",
    });
    assert.equal(result.state, "ready");
    assert.equal(mock.calls.length, 1);
    const headers = mock.calls[0].options.headers;
    assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.match(
      headers["User-Agent"],
      /^AI-Usage-Dashboard\/\d+\.\d+\.\d+$/,
    );
  } finally {
    mock.restore();
  }
});

test("openai usage totals do not double-count the audio token subsets", async () => {
  const payload = {
    data: [
      {
        results: [
          {
            model: "gpt-example",
            input_tokens: 1_000,
            output_tokens: 200,
            input_audio_tokens: 50,
            output_audio_tokens: 25,
            num_model_requests: 3,
          },
        ],
      },
    ],
  };
  const mock = mockFetch(() => jsonResponse(200, payload));
  try {
    const result = await collectOpenAIAdminUsage({
      OPENAI_ADMIN_KEY: "synthetic-admin-key",
    });
    assert.equal(result.state, "ready");
    assert.equal(result.tokenUsage.totalTokens, 1_200);
    assert.equal(result.tokenUsage.inputTokens, 1_000);
    assert.equal(result.tokenUsage.outputTokens, 200);
    assert.equal(result.tokenUsage.periodId, "rolling_7d");
    assert.equal(result.tokenUsage.scope, "account");
    assert.equal(result.tokenUsage.models[0].estimatedTokens, 1_200);
    assert.equal(result.tokenUsage.models[0].inputTokens, 1_000);
    assert.equal(result.tokenUsage.models[0].outputTokens, 200);
  } finally {
    mock.restore();
  }
});

test("kimi adapter skips unrecognized time units without failing the provider", async () => {
  const payload = {
    usage: { limit: "100", used: "10", remaining: "90" },
    limits: [
      {
        window: { duration: 5, timeUnit: "TIME_UNIT_FORTNIGHT" },
        detail: { limit: "100", used: "1", remaining: "99" },
      },
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "2", remaining: "98" },
      },
    ],
  };
  const mock = mockFetch(() => jsonResponse(200, payload));
  try {
    const result = await collectKimiUsage({
      KIMI_CODE_API_KEY: "synthetic-key",
      KIMI_CODE_HOME: "/nonexistent-kimi-home",
    });
    assert.equal(result.state, "ready");
    assert.deepEqual(
      result.windows.map((window) => window.id),
      ["five_hour", "weekly"],
    );
  } finally {
    mock.restore();
  }
});

test("kimi adapter does not misread millisecond windows as seconds", async () => {
  const payload = {
    limits: [
      {
        // A substring match on "SECOND" used to read this as 18,000 seconds
        // (a 5-hour window) instead of 18 seconds.
        window: { duration: 18_000, timeUnit: "TIME_UNIT_MILLISECOND" },
        detail: { limit: "100", used: "1", remaining: "99" },
      },
      {
        window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
        detail: { limit: "100", used: "2", remaining: "98" },
      },
    ],
  };
  const mock = mockFetch(() => jsonResponse(200, payload));
  try {
    const result = await collectKimiUsage({
      KIMI_CODE_API_KEY: "synthetic-key",
      KIMI_CODE_HOME: "/nonexistent-kimi-home",
    });
    assert.equal(result.state, "ready");
    assert.deepEqual(
      result.windows.map((window) => window.id),
      ["weekly"],
    );
  } finally {
    mock.restore();
  }
});

test("openai adapter follows usage pagination and aggregates every bucket", async () => {
  const pages = [
    {
      data: [
        {
          results: [
            {
              model: "gpt-example",
              input_tokens: 1_000,
              output_tokens: 200,
              num_model_requests: 3,
            },
          ],
        },
      ],
      has_more: true,
      next_page: "cursor-page-2",
    },
    {
      data: [
        {
          results: [
            {
              model: "gpt-example",
              input_tokens: 400,
              output_tokens: 100,
              num_model_requests: 2,
            },
          ],
        },
      ],
      has_more: false,
    },
  ];
  let call = 0;
  const mock = mockFetch(() => jsonResponse(200, pages[call++]));
  try {
    const result = await collectOpenAIAdminUsage({
      OPENAI_ADMIN_KEY: "synthetic-admin-key",
    });
    assert.equal(result.state, "ready");
    assert.equal(mock.calls.length, 2);
    const firstUrl = new URL(mock.calls[0].url);
    assert.equal(firstUrl.searchParams.get("limit"), "31");
    assert.equal(firstUrl.searchParams.get("page"), null);
    const secondUrl = new URL(mock.calls[1].url);
    assert.equal(secondUrl.searchParams.get("page"), "cursor-page-2");
    assert.equal(result.tokenUsage.totalTokens, 1_700);
    assert.equal(result.tokenUsage.requestCount, 5);
  } finally {
    mock.restore();
  }
});

test("openai adapter stops following pagination after a hard page cap", async () => {
  const mock = mockFetch(() =>
    jsonResponse(200, {
      data: [
        {
          results: [
            {
              model: "gpt-example",
              input_tokens: 10,
              output_tokens: 5,
              num_model_requests: 1,
            },
          ],
        },
      ],
      has_more: true,
      next_page: "cursor-again",
    }),
  );
  try {
    const result = await collectOpenAIAdminUsage({
      OPENAI_ADMIN_KEY: "synthetic-admin-key",
    });
    assert.equal(result.state, "ready");
    assert.equal(mock.calls.length, 5);
    assert.equal(result.tokenUsage.totalTokens, 75);
  } finally {
    mock.restore();
  }
});

test("providers report needs_configuration when their keys are absent", async () => {
  const mock = mockFetch(() => {
    throw new Error("no network call expected for unconfigured providers");
  });
  try {
    const results = await Promise.all([
      collectDeepSeekBalance({}),
      collectOpenRouterUsage({}),
      collectOpenAIAdminUsage({}),
      collectGitHubCopilotUsage({}),
    ]);
    for (const result of results) {
      assert.equal(result.state, "needs_configuration");
      assert.equal(result.tokenUsage, null);
    }
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("kimi adapter returns auth_error instead of throwing on HTTP 401", async () => {
  const mock = mockFetch(() => jsonResponse(401, { error: "unauthorized" }));
  try {
    const result = await collectKimiUsage({
      KIMI_CODE_API_KEY: "synthetic-key",
      KIMI_CODE_HOME: "/nonexistent-kimi-home",
    });
    assert.equal(result.state, "auth_error");
    assert.equal(result.tokenUsage, null);
  } finally {
    mock.restore();
  }
});

test("openai adapter returns auth_error instead of throwing on HTTP 401", async () => {
  const mock = mockFetch(() => jsonResponse(401, { error: "unauthorized" }));
  try {
    const result = await collectOpenAIAdminUsage({
      OPENAI_ADMIN_KEY: "synthetic-admin-key",
    });
    assert.equal(result.state, "auth_error");
    assert.deepEqual(result.tokenEstimates, []);
  } finally {
    mock.restore();
  }
});
