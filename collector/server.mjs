import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { collectLocalProviders } from "./providers/index.mjs";
import { collectRemoteSnapshotProviders } from "./providers/remote-snapshot.mjs";
import { HistoryStore } from "./history.mjs";
import { HUB_VERSION } from "./shared.mjs";

const HOST = process.env.USAGE_HUB_HOST || "127.0.0.1";
const PORT = Number(process.env.USAGE_HUB_PORT || 4317);
const POLL_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.USAGE_HUB_POLL_INTERVAL_MS || 60_000),
);
const STARTED_AT = new Date().toISOString();
const PRIVATE_ENV_KEYS = new Set([
  "KIMI_CODE_API_KEY",
  "KIMI_CODE_BASE_URL",
  "USAGE_HUB_PUSH_TOKEN",
  "USAGE_HUB_PUSH_URL",
  "USAGE_HUB_CLOUD_URL",
  "USAGE_HUB_VIEW_CODE_FILE",
  "USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY",
  "USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY",
  "USAGE_HUB_CODEX_LOG_ESTIMATE",
]);

async function loadPrivateEnvironment() {
  const path =
    process.env.USAGE_HUB_ENV_FILE || join(homedir(), ".usage-hub", "env");
  try {
    const contents = await readFile(path, "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (PRIVATE_ENV_KEYS.has(key)) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`无法读取私密配置：${error.message}`);
    }
  }
}

await loadPrivateEnvironment();

const history = new HistoryStore();
let latest = {
  generatedAt: null,
  collector: {
    host: hostname(),
    version: HUB_VERSION,
    state: "starting",
    startedAt: STARTED_AT,
  },
  providers: [],
};
let refreshPromise = null;

function outboundSnapshot(snapshot) {
  return {
    generatedAt: snapshot.generatedAt,
    collector: {
      version: snapshot.collector.version,
      state: snapshot.collector.state,
      startedAt: snapshot.collector.startedAt,
    },
    providers: snapshot.providers
      .filter((provider) => provider.sourceKind !== "remote_snapshot")
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        shortName: provider.shortName,
        accent: provider.accent,
        state: provider.state,
        plan: provider.plan,
        source: provider.source,
        sourceKind: provider.sourceKind,
        updatedAt: provider.updatedAt,
        windows: provider.windows,
        balance: provider.balance,
        message: provider.message,
        tokenUsage: provider.tokenUsage,
        tokenEstimates: provider.tokenEstimates,
      })),
  };
}

async function pushRemoteSnapshot(snapshot) {
  const url = process.env.USAGE_HUB_PUSH_URL?.trim();
  const token = process.env.USAGE_HUB_PUSH_TOKEN?.trim();
  if (!url || !token) return;
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:") {
    throw new Error("远端同步地址必须使用 HTTPS");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": `AI-Usage-Dashboard/${HUB_VERSION}`,
      },
      body: JSON.stringify(outboundSnapshot(snapshot)),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`远端同步返回 HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    await loadPrivateEnvironment();
    const localProviders = await collectLocalProviders(process.env);
    const remoteProviders = await collectRemoteSnapshotProviders(
      process.env,
      localProviders.map((provider) => provider.id),
    );
    const providers = [...localProviders, ...remoteProviders];
    const generatedAt = new Date();
    history.save(providers, generatedAt);
    latest = {
      generatedAt: generatedAt.toISOString(),
      collector: {
        host: hostname(),
        version: HUB_VERSION,
        state: providers.some((provider) => provider.state === "ready")
          ? "online"
          : "attention",
        startedAt: STARTED_AT,
      },
      providers,
    };
    try {
      await pushRemoteSnapshot(latest);
    } catch (error) {
      console.warn(`远端同步失败：${error?.message || "未知错误"}`);
    }
    return latest;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

function corsHeaders(origin) {
  const allowed = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : "http://localhost:3000",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function sendJson(response, status, payload, origin = "") {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(origin),
  });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(origin));
    response.end();
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  try {
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, {
        ok: true,
        version: HUB_VERSION,
        host: hostname(),
        generatedAt: latest.generatedAt,
      }, origin);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/usage") {
      if (!latest.generatedAt) await refresh();
      sendJson(response, 200, latest, origin);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/history") {
      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        points: history.recent(url.searchParams.get("hours")),
      }, origin);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      sendJson(response, 200, await refresh(), origin);
      return;
    }
    sendJson(response, 404, { error: "Not found" }, origin);
  } catch (error) {
    sendJson(response, 500, {
      error: "collector_error",
      message: error?.message || "Collector failed",
    }, origin);
  }
});

await refresh();
server.listen(PORT, HOST, () => {
  console.log(`AI Usage Dashboard collector: http://${HOST}:${PORT}`);
});

const interval = setInterval(refresh, POLL_INTERVAL_MS);
interval.unref();

function shutdown() {
  clearInterval(interval);
  server.close(() => {
    history.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
