import assert from "node:assert/strict";
import test from "node:test";
import { collectGitHubCopilotUsage } from "../collector/providers/github-copilot.mjs";
import { collectKimiUsage } from "../collector/providers/kimi.mjs";
import { collectOpenAIAdminUsage } from "../collector/providers/openai-api.mjs";

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

test("kimi adapter fails loudly on an unrecognized time unit", async () => {
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
    assert.equal(result.state, "error");
    assert.deepEqual(result.windows, []);
    assert.match(result.message, /TIME_UNIT_FORTNIGHT/);
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
