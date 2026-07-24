import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("build contains the usage dashboard shell and protected remote routes", async () => {
  const [page, dashboard, layout, routes, clientAssets] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/usage-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    Promise.all([
      readFile(new URL("../app/api/usage/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/history/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/ingest/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/session/route.ts", import.meta.url), "utf8"),
    ]),
    readdir(new URL("../dist/client/assets/", import.meta.url)),
  ]);

  assert.match(page, /<UsageDashboard \/>/);
  assert.match(layout, /AI Usage Dashboard/);
  assert.match(dashboard, /AI Usage Dashboard/);
  assert.match(dashboard, /OpenAI Codex/);
  assert.match(dashboard, /Kimi Code/);
  assert.match(dashboard, /Token 用量 · 双口径/);
  assert.match(dashboard, /周 Token 双口径估算总览/);
  assert.match(dashboard, /凭证不进入云端/);
  assert.match(dashboard, /PRIVATE DISPLAY/);
  assert.match(dashboard, /dashboard--compact/);
  assert.ok(routes.every((route) => /is(Viewer|Ingest)Authorized/.test(route)));
  assert.ok(clientAssets.some((file) => file.startsWith("usage-dashboard-")));
  assert.doesNotMatch(dashboard, /codex-preview|react-loading-skeleton/);
});
