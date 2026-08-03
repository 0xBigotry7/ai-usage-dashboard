import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let sessionCookie = null;
let lastProviders = [];

async function timedFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function safeOrigin(value) {
  if (!value) throw new Error("未配置 USAGE_HUB_CLOUD_URL");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  ) {
    throw new Error("远端快照地址必须是无凭证的 HTTPS 根地址");
  }
  return url.origin;
}

async function login(origin, viewCodePath) {
  const code = (await readFile(viewCodePath, "utf8")).trim();
  if (!code) throw new Error("本机缺少用量面板查看码");
  const response = await timedFetch(`${origin}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    throw new Error(`云端查看码验证返回 HTTP ${response.status}`);
  }
  // getSetCookie keeps multiple Set-Cookie headers separate; the joined
  // "set-cookie" string cannot be split safely (cookie attributes contain
  // commas), so only fall back to it when getSetCookie is unavailable.
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  const setCookie =
    setCookies.find((value) => value?.trim()) ??
    response.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0]?.trim();
  if (!cookie) throw new Error("云端没有返回查看会话");
  sessionCookie = cookie;
}

async function fetchSnapshot(origin, viewCodePath) {
  if (!sessionCookie) await login(origin, viewCodePath);
  let response = await timedFetch(`${origin}/api/usage`, {
    headers: { Cookie: sessionCookie },
  });
  if (response.status === 401) {
    sessionCookie = null;
    await login(origin, viewCodePath);
    response = await timedFetch(`${origin}/api/usage`, {
      headers: { Cookie: sessionCookie },
    });
  }
  if (!response.ok) {
    throw new Error(`云端快照返回 HTTP ${response.status}`);
  }
  return response.json();
}

function cloneRemoteProvider(provider) {
  return {
    id: provider.id,
    name: provider.name || provider.id,
    shortName:
      provider.shortName || String(provider.id || "").slice(0, 2).toUpperCase(),
    accent: provider.accent || "#7bf1a8",
    state: provider.state,
    plan: provider.plan ?? null,
    source: `${provider.source || provider.name || provider.id} · 脱敏快照`,
    sourceKind: "remote_snapshot",
    updatedAt: provider.updatedAt,
    windows: Array.isArray(provider.windows) ? provider.windows : [],
    balance: provider.balance ?? null,
    message: provider.message ?? null,
    tokenUsage: provider.tokenUsage ?? null,
    tokenEstimates: Array.isArray(provider.tokenEstimates)
      ? provider.tokenEstimates
      : provider.tokenUsage
        ? [provider.tokenUsage]
        : [],
  };
}

export async function collectRemoteSnapshotProviders(
  env = process.env,
  excludedProviderIds = [],
) {
  if (!env.USAGE_HUB_CLOUD_URL?.trim()) return [];
  const excluded = new Set(excludedProviderIds);
  try {
    const origin = safeOrigin(env.USAGE_HUB_CLOUD_URL.trim());
    const viewCodePath =
      env.USAGE_HUB_VIEW_CODE_FILE ||
      join(homedir(), ".usage-hub", "view-code");
    const snapshot = await fetchSnapshot(origin, viewCodePath);
    const providers = (Array.isArray(snapshot?.providers)
      ? snapshot.providers
      : []
    )
      .filter(
        (provider) =>
          provider &&
          typeof provider.id === "string" &&
          !excluded.has(provider.id),
      )
      .map(cloneRemoteProvider);
    lastProviders = providers;
    return providers;
  } catch (error) {
    if (lastProviders.length === 0) {
      console.warn(`无法读取远端脱敏快照：${error?.message || "未知错误"}`);
      return [];
    }
    return lastProviders.map((provider) => ({
      ...provider,
      source: `${provider.source} · 上次成功数据`,
      message: `远端快照暂时不可用；显示上次成功数据。${
        error?.message ? ` ${error.message}` : ""
      }`,
    }));
  }
}
