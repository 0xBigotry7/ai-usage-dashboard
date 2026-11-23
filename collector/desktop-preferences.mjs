import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sources from "./desktop-sources.json" with { type: "json" };

const catalog = new Map(sources.map(source => [source.id, source]));
const defaults = { widgetEnabled: true, shortcuts: {}, sources: {} };

export async function readDesktopPreferences(path = join(homedir(), ".usage-hub", "desktop-connections.json")) {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (data.version !== 1) throw new Error("Unsupported desktop configuration version");
    return { widgetEnabled: data.widgetEnabled !== false, shortcuts: data.shortcuts ?? {}, sources: data.sources ?? {} };
  } catch (error) {
    if (error.code === "ENOENT") return defaults;
    // A broken file must not silently resume account access.
    throw new Error("Cannot read desktop connection settings");
  }
}

export function sourceConfiguration(id, desktop, base) {
  const record = desktop?.sources?.[id];
  const mode = record?.mode ?? "auto";
  const overrides = {};
  if (mode === "on") {
    for (const {key, kind} of catalog.get(id)?.fields ?? []) {
      const value = record?.values?.[key];
      if (kind === "toggle") overrides[key] = value === "1" ? "1" : "0";
      else if (typeof value === "string" && value.trim()) overrides[key] = value.trim();
    }
    if (id === "claude-fable") overrides.USAGE_HUB_CLAUDE_OAUTH_USAGE = "1";
    if (id === "cursor" || id === "grok-bot") overrides.USAGE_HUB_CURSOR_DESKTOP = "1";
  }
  // Hash only credential/configuration inputs. Never place these values in the public snapshot.
  const fields = catalog.get(id)?.fields ?? [];
  const env = { ...base, ...overrides };
  const revision = createHash("sha256").update(JSON.stringify([mode, ...fields.map(f => env[f.key])])).digest("hex");
  return {mode, env, revision};
}

const DAY = 86_400_000;
const STALE_AFTER_MS = 10 * 60_000;
const CLAUDE_STALE_AFTER_MS = 45 * 60_000;

// When a window stops being valid: at its reset time, or for a manually
// entered day-only reset, at the end of that day.
function windowExpiry(window) {
  if (window.resetsAt) return Date.parse(window.resetsAt);
  return window.resetDate ? Date.parse(`${window.resetDate}T00:00:00`) + DAY : NaN;
}

// Same staleness rule as the menu bar and the web dashboard: a manual
// snapshot stays valid until its window ends; every other reading goes stale
// with age.
export function widgetSnapshot(snapshot, enabled, now = Date.now()) {
  if (!enabled) return {enabled: false, pools: []};
  const pools = [];
  for (const provider of snapshot.providers) {
    if (provider.state !== "ready") continue;
    const withQuota = provider.windows.filter(w => Number.isFinite(w.usedPercent));
    const window = withQuota.find(w => w.id === "weekly") ?? withQuota.at(-1);
    if (!window || windowExpiry(window) <= now) continue;
    const readAt = Date.parse(provider.updatedAt);
    const staleAfter = provider.id.startsWith("claude") ? CLAUDE_STALE_AFTER_MS : STALE_AFTER_MS;
    const ages = provider.sourceKind !== "manual";
    pools.push({
      id: provider.id, name: provider.name,
      remaining: Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent))),
      reset: window.resetDate || window.resetsAt || null, dayOnly: Boolean(window.resetDate),
      stale: ages && (!Number.isFinite(readAt) || now - readAt > staleAfter),
      // WidgetKit may not ask again for a long time, so the widget is told
      // when this reading turns stale and can mark it by itself.
      staleAt: ages && Number.isFinite(readAt) ? new Date(readAt + staleAfter).toISOString() : null,
    });
  }
  pools.sort((a,b) => Number(a.stale) - Number(b.stale) || a.remaining - b.remaining || a.id.localeCompare(b.id));
  return {enabled: true, pools};
}
