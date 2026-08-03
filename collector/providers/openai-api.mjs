import { hostname } from "node:os";
import { fetchJson, HUB_VERSION, providerError } from "../shared.mjs";

const OPENAI_API = {
  id: "openai-api",
  name: "OpenAI API",
  shortName: "OA",
  accent: "#8fd8b4",
  authMessage:
    "OpenAI Admin API Key 不可用；请检查本机 OPENAI_ADMIN_KEY 配置。",
};

const DEFAULT_USAGE_URL =
  "https://api.openai.com/v1/organization/usage/completions";
const PERIOD_SECONDS = 7 * 24 * 60 * 60;
// A 7-day span can cross 8 UTC day buckets; request more than enough per page
// and follow the pagination cursor with a hard page cap as a safety net.
const PAGE_BUCKET_LIMIT = 31;
const MAX_USAGE_PAGES = 5;

function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function normalizeOpenAIAdminUsage(
  payload,
  updatedAt = new Date().toISOString(),
) {
  const byModel = new Map();
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let requestCount = 0;

  for (const bucket of payload?.data || []) {
    for (const result of bucket?.results || []) {
      // Per the OpenAI Usage API docs, input_tokens already includes the
      // audio/image subsets, so only input + output are summed here.
      const inputTokens = safeCount(result?.input_tokens);
      const outputTokens = safeCount(result?.output_tokens);
      const tokens = inputTokens + outputTokens;
      const requests = safeCount(result?.num_model_requests);
      const model = String(result?.model || "unattributed").slice(0, 80);
      const current = byModel.get(model) || {
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
      };
      current.tokens += tokens;
      current.inputTokens += inputTokens;
      current.outputTokens += outputTokens;
      current.requests += requests;
      byModel.set(model, current);
      totalTokens += tokens;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      requestCount += requests;
    }
  }

  const models = Array.from(byModel, ([id, usage]) => ({
    id,
    label: id === "unattributed" ? "未归因模型" : id,
    estimatedTokens: usage.tokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    requestCount: usage.requests,
    countedInTotal: true,
  })).sort((left, right) => right.estimatedTokens - left.estimatedTokens);

  const tokenUsage =
    models.length > 0
      ? {
          basis: "api_usage",
          periodId: "rolling_7d",
          scope: "account",
          estimated: false,
          totalTokens,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          periodSeconds: PERIOD_SECONDS,
          requestCount,
          models,
          assumption:
            "来自 OpenAI Organization Usage API 的过去 7 天模型用量。",
        }
      : null;

  return {
    id: OPENAI_API.id,
    name: OPENAI_API.name,
    shortName: OPENAI_API.shortName,
    accent: OPENAI_API.accent,
    state: "ready",
    plan: "API Organization",
    source: "OpenAI Organization Usage API",
    sourceKind: "admin_api",
    host: hostname(),
    updatedAt,
    windows: [],
    balance: null,
    message:
      requestCount > 0
        ? `官方 Usage API · 过去 7 天 ${requestCount.toLocaleString("en-US")} 次模型请求`
        : "OpenAI Usage API 当前没有返回过去 7 天的模型请求。",
    tokenUsage,
    tokenEstimates: tokenUsage ? [tokenUsage] : [],
  };
}

export async function collectOpenAIAdminUsage(env = process.env) {
  const updatedAt = new Date().toISOString();
  const adminKey = env.OPENAI_ADMIN_KEY?.trim();
  if (!adminKey) {
    const error = new Error("缺少 OPENAI_ADMIN_KEY");
    error.status = 401;
    const result = providerError(
      OPENAI_API,
      error,
      "等待 OpenAI Admin API Key",
      updatedAt,
    );
    result.state = "needs_configuration";
    result.tokenUsage = null;
    return result;
  }

  try {
    const endpoint = new URL(DEFAULT_USAGE_URL);
    endpoint.searchParams.set(
      "start_time",
      String(Math.floor(Date.now() / 1000) - PERIOD_SECONDS),
    );
    endpoint.searchParams.set("bucket_width", "1d");
    endpoint.searchParams.set("limit", String(PAGE_BUCKET_LIMIT));
    endpoint.searchParams.append("group_by[]", "model");

    const headers = {
      Authorization: `Bearer ${adminKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": `AI-Usage-Dashboard/${HUB_VERSION}`,
    };
    const data = [];
    let pageCursor = null;
    for (let page = 0; page < MAX_USAGE_PAGES; page += 1) {
      const pageUrl = new URL(endpoint);
      if (pageCursor) pageUrl.searchParams.set("page", pageCursor);
      const payload = await fetchJson(pageUrl, { headers });
      if (Array.isArray(payload?.data)) data.push(...payload.data);
      if (!payload?.has_more || !payload?.next_page) break;
      pageCursor = String(payload.next_page);
    }
    return normalizeOpenAIAdminUsage({ data }, updatedAt);
  } catch (error) {
    return {
      ...providerError(
        OPENAI_API,
        error,
        "OpenAI Organization Usage API",
        updatedAt,
      ),
      tokenUsage: null,
      tokenEstimates: [],
    };
  }
}
