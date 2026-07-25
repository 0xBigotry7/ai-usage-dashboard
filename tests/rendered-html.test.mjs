import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("build contains the dashboard, dedicated display, brands, and protected routes", async () => {
  const [page, displayPage, dashboard, providerLogo, layout, routes, clientAssets, brandAssets, publicAssets] =
    await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/display/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/usage-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/provider-logo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    Promise.all([
      readFile(new URL("../app/api/usage/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/history/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/ingest/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/session/route.ts", import.meta.url), "utf8"),
    ]),
    readdir(new URL("../dist/client/assets/", import.meta.url)),
    readdir(new URL("../public/brands/", import.meta.url)),
    readdir(new URL("../public/", import.meta.url)),
  ]);

  assert.match(page, /<UsageDashboard \/>/);
  assert.match(displayPage, /<UsageDashboard displayMode \/>/);
  assert.match(layout, /AI Usage Dashboard/);
  assert.match(layout, /openGraph/);
  assert.ok(publicAssets.includes("og.png"));
  assert.match(dashboard, /AI Usage Dashboard/);
  assert.match(dashboard, /OpenAI Codex/);
  assert.match(dashboard, /Kimi Code/);
  assert.match(dashboard, /Token 用量 · 多口径/);
  assert.match(dashboard, /周 Token · 多口径/);
  assert.match(dashboard, /官方 API、配额换算与 CLI 日志/);
  assert.match(dashboard, /Dashboard 显示设置/);
  assert.match(dashboard, /关注阈值/);
  assert.match(dashboard, /复制当前脱敏摘要/);
  assert.match(dashboard, /凭证不进入云端/);
  assert.match(dashboard, /PRIVATE DISPLAY/);
  assert.match(dashboard, /DedicatedDisplay/);
  assert.match(dashboard, /480×320 · 800×480/);
  assert.match(dashboard, /历史积累中/);
  assert.match(dashboard, /数据已过期/);
  assert.doesNotMatch(dashboard, /setCompact|dashboard--compact/);
  assert.match(providerLogo, /BRAND_ASSETS/);
  assert.ok(
    ["claude.svg", "codex.svg", "openai.svg", "kimi.svg", "deepseek.svg", "openrouter.svg", "githubcopilot.svg"]
      .every((file) => brandAssets.includes(file)),
  );
  assert.ok(routes.every((route) => /is(Viewer|Ingest)Authorized/.test(route)));
  assert.ok(clientAssets.some((file) => file.startsWith("usage-dashboard-")));
  assert.doesNotMatch(dashboard, /codex-preview|react-loading-skeleton/);
});
