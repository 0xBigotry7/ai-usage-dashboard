import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

// The dashboard is split across a top-level component plus extracted
// components, hooks, and lib helpers; assert against the combined sources.
async function readDashboardSources() {
  const files = [
    new URL("../app/usage-dashboard.tsx", import.meta.url),
    new URL("../lib/format.ts", import.meta.url),
    new URL("../lib/provider-selectors.ts", import.meta.url),
    new URL("../lib/usage-types.ts", import.meta.url),
  ];
  for (const dir of [
    new URL("../app/components/", import.meta.url),
    new URL("../app/hooks/", import.meta.url),
  ]) {
    for (const entry of await readdir(dir)) {
      files.push(new URL(entry, dir));
    }
  }
  const sources = await Promise.all(
    files.map((file) => readFile(file, "utf8")),
  );
  return sources.join("\n");
}

test("build contains the dashboard, dedicated display, brands, and protected routes", async () => {
  const [page, displayPage, dashboard, providerLogo, layout, routes, clientAssets, brandAssets, publicAssets] =
    await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/display/page.tsx", import.meta.url), "utf8"),
    readDashboardSources(),
    readFile(new URL("../app/provider-logo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    Promise.all([
      readFile(new URL("../app/api/usage/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/history/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/ingest/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/session/route.ts", import.meta.url), "utf8"),
    ]),
    // vinext moved client build output from assets/ to _next/ — accept either.
    readdir(new URL("../dist/client/assets/", import.meta.url)).catch(() =>
      readdir(new URL("../dist/client/_next/", import.meta.url), {
        recursive: true,
      }),
    ),
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
  assert.match(dashboard, /Token usage · layered views/);
  assert.match(dashboard, /Tokens recorded today/);
  assert.match(dashboard, /Recorded this subscription cycle/);
  assert.match(dashboard, /Quota conversion/);
  assert.match(dashboard, /Input \+ output = total/);
  assert.match(dashboard, /cached input and reasoning output are subsets, not added twice/);
  assert.match(dashboard, /no observed data for/);
  assert.match(dashboard, /History truncated; showing only the most recent data/);
  assert.match(dashboard, /Dashboard display settings/);
  assert.match(dashboard, /Warning threshold/);
  assert.match(dashboard, /Copy a sanitized usage summary/);
  assert.match(dashboard, /Credentials never leave this machine/);
  assert.match(dashboard, /PRIVATE DISPLAY/);
  assert.match(dashboard, /DedicatedDisplay/);
  assert.match(dashboard, /480×320 · 800×480/);
  assert.match(dashboard, /Collecting history/);
  assert.match(dashboard, /Data stale/);
  assert.doesNotMatch(dashboard, /setCompact|dashboard--compact/);
  assert.doesNotMatch(dashboard, /missing-window/);
  assert.match(providerLogo, /BRAND_ASSETS/);
  assert.ok(
    [
      "claude.svg",
      "claude-color.svg",
      "codex.svg",
      "codex-color.svg",
      "openai.svg",
      "kimi.svg",
      "kimi-color.svg",
      "deepseek.svg",
      "openrouter.svg",
      "githubcopilot.svg",
    ]
      .every((file) => brandAssets.includes(file)),
  );
  assert.ok(routes.every((route) => /is(Viewer|Ingest)Authorized/.test(route)));
  assert.ok(
    clientAssets.some((file) =>
      String(file).split("/").pop().startsWith("usage-dashboard-"),
    ),
  );
  assert.doesNotMatch(dashboard, /codex-preview|react-loading-skeleton/);
});
