import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The web modules import each other without file extensions (the bundler
// resolves them). Teach Node the same rule so they can be tested directly.
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    try {
      return await next(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      return next(specifier + ".ts", context);
    }
  }
`)}`);

const { buildCopySummary } = await import("../lib/copy-summary.ts");
const { formatAge, formatQuotaReset, formatUpdated } = await import("../lib/format.ts");
const {
  getPrimaryWindow,
  healthSummary,
  isProviderStale,
  isWindowExpired,
  providerHealth,
  providerStateLabel,
} = await import("../lib/provider-selectors.ts");
const { sanitizeRemoteSnapshot } = await import("../lib/remote-usage.ts");

const now = Date.parse("2030-01-03T12:00:00Z");
const minutesAgo = (minutes) => new Date(now - minutes * 60_000).toISOString();
const weekly = (extra = {}) => ({
  id: "weekly", label: "Weekly", durationSeconds: 604_800, usedPercent: 20,
  used: null, limit: null, remaining: null, resetsAt: "2030-01-08T00:00:00Z", ...extra,
});
const provider = (id, extra = {}) => ({
  id, name: id, shortName: "XX", accent: "#fff", state: "ready", plan: null, source: "test",
  updatedAt: minutesAgo(1), windows: [weekly()], balance: null, message: null, tokenUsage: null, ...extra,
});

test("a reading goes stale with age, with the longer allowance for both Claude cards", () => {
  assert.equal(isProviderStale(provider("codex", { updatedAt: minutesAgo(9) }), now), false);
  assert.equal(isProviderStale(provider("codex", { updatedAt: minutesAgo(11) }), now), true);
  assert.equal(isProviderStale(provider("claude", { updatedAt: minutesAgo(30) }), now), false);
  assert.equal(isProviderStale(provider("claude-fable", { updatedAt: minutesAgo(30) }), now), false);
  assert.equal(isProviderStale(provider("claude", { updatedAt: minutesAgo(2 * 24 * 60) }), now), true);
  assert.equal(isProviderStale(provider("codex", { updatedAt: "" }), now), true);
});

test("a window past its reset makes the reading stale; a manual snapshot lasts until its window ends", () => {
  assert.equal(isWindowExpired(weekly({ resetsAt: "2030-01-03T11:59:00Z" }), now), true);
  assert.equal(isWindowExpired(weekly({ resetsAt: null }), now), false);
  const passed = provider("codex", { windows: [weekly({ resetsAt: "2030-01-03T11:59:00Z" })] });
  assert.equal(isProviderStale(passed, now), true);
  const manual = provider("muse", { sourceKind: "manual", updatedAt: minutesAgo(3 * 24 * 60) });
  assert.equal(isProviderStale(manual, now), false);
  const ended = { ...manual, windows: [weekly({ resetsAt: "2030-01-02T00:00:00Z" })] };
  assert.equal(isProviderStale(ended, now), true);
});

test("a source that is not ready is never counted or labelled as live", () => {
  const broken = provider("cursor", { state: "error", windows: [], updatedAt: minutesAgo(1) });
  const waiting = provider("claude-fable", { state: "auth_error", windows: [], updatedAt: minutesAgo(40 * 60) });
  assert.equal(providerHealth(broken, now), "unavailable");
  // The reason it failed is shown, not hidden behind "Data stale".
  assert.equal(providerStateLabel(waiting, now), "Sign-in required");
  const summary = healthSummary([
    provider("codex"), provider("grok"), provider("claude", { updatedAt: minutesAgo(90) }), broken, waiting,
  ], now);
  assert.equal(summary.text, "2 live · 1 stale · 2 unavailable");
  assert.equal(healthSummary([provider("codex")], now).text, "1 live");
});

test("the primary window is the weekly reading, or the last window that has a reading", () => {
  const fiveHour = weekly({ id: "five_hour", label: "5-hour", usedPercent: 40 });
  assert.equal(getPrimaryWindow(provider("a", { windows: [fiveHour, weekly()] })).id, "weekly");
  assert.equal(getPrimaryWindow(provider("a", { windows: [fiveHour, weekly({ usedPercent: null })] })).id, "five_hour");
  assert.equal(getPrimaryWindow(provider("a", { windows: [weekly({ usedPercent: null })] })), null);
});

test("the copied summary reports what is left and flags readings that are not current", () => {
  const resets = new Map();
  const text = buildCopySummary({
    generatedAt: minutesAgo(0),
    resets,
    providers: [
      provider("Codex", { updatedAt: new Date(Date.now() - 60_000).toISOString() }),
      provider("Claude", { updatedAt: new Date(Date.now() - 2 * 24 * 3_600_000).toISOString() }),
    ],
  });
  assert.match(text, /Codex: Weekly 80% remaining$/m);
  assert.match(text, /Claude: Weekly 80% remaining · stale, read 2d ago$/m);
});

test("formatters survive a timestamp they cannot parse", () => {
  assert.equal(formatUpdated("garbage"), "—");
  assert.equal(formatQuotaReset("garbage"), "—");
  assert.equal(formatAge("garbage", now), "unknown");
  assert.equal(formatAge(minutesAgo(125), now), "2h ago");
});

test("the cloud validator never turns a missing reading or time into a real-looking one", () => {
  const { providers } = sanitizeRemoteSnapshot({
    generatedAt: minutesAgo(0),
    providers: [{
      id: "codex", name: "Codex", state: "ready", updatedAt: null,
      windows: [
        { id: "weekly", label: "Weekly", usedPercent: "", resetsAt: null },
        { id: "five_hour", label: "5-hour", usedPercent: 37.5, resetsAt: null },
      ],
    }],
  });
  assert.equal(providers[0].updatedAt, "");
  assert.deepEqual(providers[0].windows.map((w) => [w.id, w.usedPercent]), [["weekly", null], ["five_hour", 37.5]]);
  assert.equal(isProviderStale(providers[0]), true);
});
