import assert from "node:assert/strict";
import test from "node:test";
import { collectDeepSeekBalance } from "../collector/providers/deepseek.mjs";
import { collectGitHubCopilotUsage } from "../collector/providers/github-copilot.mjs";
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
