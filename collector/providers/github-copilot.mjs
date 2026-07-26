import { hostname } from "node:os";
import {
  fetchJson,
  HUB_VERSION,
  numberOrNull,
  providerError,
  usagePercent,
} from "../shared.mjs";

const GITHUB_COPILOT = {
  id: "github-copilot",
  name: "GitHub Copilot",
  shortName: "GH",
  accent: "#f0c96b",
  authMessage:
    "GitHub Token 不可用；需要具有 Plan: read 权限的 Fine-grained Token。",
};

function nextMonthUtc() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  ).toISOString();
}

export function normalizeGitHubCopilotUsage(
  payload,
  {
    updatedAt = new Date().toISOString(),
    monthlyLimit = null,
  } = {},
) {
  const byModel = new Map();
  let used = 0;

  for (const item of payload?.usageItems || []) {
    const product = String(item?.product || "");
    if (!/copilot|ai credit/i.test(product)) continue;
    const quantity =
      numberOrNull(item?.grossQuantity) ??
      numberOrNull(item?.netQuantity) ??
      0;
    const model = String(item?.model || "未归因模型").slice(0, 60);
    used += quantity;
    byModel.set(model, (byModel.get(model) || 0) + quantity);
  }

  const limit = numberOrNull(monthlyLimit);
  const remaining =
    limit !== null ? Math.max(0, Math.round((limit - used) * 100) / 100) : null;
  const topModels = Array.from(byModel, ([model, value]) => ({ model, value }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 3);

  return {
    id: GITHUB_COPILOT.id,
    name: GITHUB_COPILOT.name,
    shortName: GITHUB_COPILOT.shortName,
    accent: GITHUB_COPILOT.accent,
    state: "ready",
    plan: "Copilot Billing",
    source: "GitHub AI Credits Billing API",
    sourceKind: "fine_grained_token",
    host: hostname(),
    updatedAt,
    windows: [
      {
        id: "monthly",
        label: "本月",
        durationSeconds: 2_592_000,
        usedPercent: usagePercent({ used, limit, remaining }),
        used,
        limit,
        remaining,
        resetsAt: nextMonthUtc(),
      },
    ],
    balance: {
      label: "本月 AI Credits",
      value: used,
      unit: "credits",
    },
    message: topModels.length
      ? `模型 Credits：${topModels
          .map(({ model, value }) => `${model} ${Math.round(value * 100) / 100}`)
          .join(" · ")}`
      : "GitHub Billing API 当前没有返回本月 Copilot AI Credits。",
    tokenUsage: null,
    tokenEstimates: [],
  };
}

export async function collectGitHubCopilotUsage(env = process.env) {
  const updatedAt = new Date().toISOString();
  const token = env.GITHUB_COPILOT_TOKEN?.trim();
  const username = env.GITHUB_COPILOT_USERNAME?.trim();
  if (!token || !username) {
    const error = new Error(
      "缺少 GITHUB_COPILOT_TOKEN 或 GITHUB_COPILOT_USERNAME",
    );
    error.status = 401;
    return providerError(
      GITHUB_COPILOT,
      error,
      "等待 GitHub Copilot Billing 配置",
      updatedAt,
    );
  }

  try {
    const now = new Date();
    const endpoint = new URL(
      `https://api.github.com/users/${encodeURIComponent(
        username,
      )}/settings/billing/ai_credit/usage`,
    );
    endpoint.searchParams.set("year", String(now.getUTCFullYear()));
    endpoint.searchParams.set("month", String(now.getUTCMonth() + 1));

    const payload = await fetchJson(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `AI-Usage-Dashboard/${HUB_VERSION}`,
      },
    });
    return normalizeGitHubCopilotUsage(payload, {
      updatedAt,
      monthlyLimit: env.GITHUB_COPILOT_MONTHLY_CREDIT_LIMIT,
    });
  } catch (error) {
    return providerError(
      GITHUB_COPILOT,
      error,
      "GitHub AI Credits Billing API",
      updatedAt,
    );
  }
}
