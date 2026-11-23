import { existsSync } from "node:fs";
import { claudeProjectsDir } from "../claude-session-log.mjs";
import { collectAntigravityUsage } from "./antigravity.mjs";
import { claudeOAuthUsageEnabled } from "../claude-oauth-usage.mjs";
import { collectClaudeCodeUsage, collectClaudeFableUsage } from "./claude-code.mjs";
import { collectCodexUsage } from "./codex.mjs";
import { collectCursorUsage, collectGrokBotUsage } from "./cursor.mjs";
import { collectDeepSeekBalance } from "./deepseek.mjs";
import { collectGitHubCopilotUsage } from "./github-copilot.mjs";
import { collectGrokUsage, groupGrokSharedUsage } from "./grok.mjs";
import { collectKimiUsage } from "./kimi.mjs";
import { collectMuseUsage } from "./muse.mjs";
import { collectOpenAIAdminUsage } from "./openai-api.mjs";
import { collectOpenRouterUsage } from "./openrouter.mjs";
import { collectOpenCodeGoUsage } from "./opencode-go.mjs";
import { createProviderRefreshCoordinator } from "../provider-refresh.mjs";
import { sourceConfiguration } from "../desktop-preferences.mjs";

const coordinators = new Map();

export const providerAdapters = [
  {
    id: "codex",
    name: "OpenAI Codex",
    defaultEnabled: true,
    collect: collectCodexUsage,
  },
  {
    id: "muse",
    name: "Meta Muse",
    configured: (env) => Boolean(env.USAGE_HUB_MUSE_FILE?.trim()),
    // A local file the user edits by hand: re-read it on every cycle.
    pollIntervalMs: 1,
    collect: collectMuseUsage,
  },
  {
    id: "claude",
    name: "Claude Code",
    defaultEnabled: false,
    configured: (env) =>
      Boolean(env.USAGE_HUB_CLAUDE_QUOTA_FILE?.trim()) ||
      claudeOAuthUsageEnabled(env) ||
      existsSync(claudeProjectsDir(env)),
    collect: collectClaudeCodeUsage,
  },
  {
    id: "claude-fable",
    name: "Claude Fable",
    configured: (env) => claudeOAuthUsageEnabled(env),
    collect: collectClaudeFableUsage,
  },
  {
    id: "kimi",
    name: "Kimi Code",
    defaultEnabled: true,
    collect: collectKimiUsage,
  },
  {
    id: "openai-api",
    name: "OpenAI API",
    configured: (env) => Boolean(env.OPENAI_ADMIN_KEY?.trim()),
    collect: collectOpenAIAdminUsage,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    configured: (env) => Boolean(env.OPENROUTER_API_KEY?.trim()),
    collect: collectOpenRouterUsage,
  },
  {
    id: "deepseek",
    name: "DeepSeek API",
    configured: (env) => Boolean(env.DEEPSEEK_API_KEY?.trim()),
    collect: collectDeepSeekBalance,
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    configured: (env) => Boolean(env.OPENCODE_GO_API_KEY?.trim()),
    collect: collectOpenCodeGoUsage,
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    configured: (env) =>
      Boolean(
        env.GITHUB_COPILOT_TOKEN?.trim() &&
          env.GITHUB_COPILOT_USERNAME?.trim(),
      ),
    collect: collectGitHubCopilotUsage,
  },
  {
    id: "grok",
    name: "Grok",
    configured: (env) => Boolean(env.USAGE_HUB_GROK_BIN?.trim()),
    collect: collectGrokUsage,
  },
  {
    id: "cursor",
    name: "Cursor",
    configured: (env) => env.USAGE_HUB_CURSOR_DESKTOP === "1",
    collect: collectCursorUsage,
  },
  {
    id: "grok-bot",
    name: "Grok Bot",
    configured: (env) => env.USAGE_HUB_CURSOR_DESKTOP === "1",
    collect: collectGrokBotUsage,
  },
  {
    id: "antigravity",
    name: "Antigravity",
    configured: (env) => Boolean(env.USAGE_HUB_AGY_BIN?.trim()),
    collect: collectAntigravityUsage,
  },
];

function parseProviderList(value) {
  const ids = value?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return ids?.length ? new Set(ids) : null;
}

function enabledAdapters(env) {
  const selected = parseProviderList(env.USAGE_HUB_PROVIDERS);
  // Subtractive override: keep the default/auto-detected set but pin
  // specific providers off (e.g. a laptop whose Claude usage is already
  // reported by another machine via cloud sync).
  const disabled = parseProviderList(env.USAGE_HUB_DISABLE_PROVIDERS);
  return providerAdapters.filter((adapter) => {
    if (disabled?.has(adapter.id)) return false;
    if (selected) return selected.has(adapter.id);
    return adapter.defaultEnabled || adapter.configured?.(env);
  });
}

export function providerCatalog(env = process.env) {
  const enabled = new Set(enabledAdapters(env).map((adapter) => adapter.id));
  return providerAdapters.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    enabled: enabled.has(adapter.id),
    configured: adapter.defaultEnabled || Boolean(adapter.configured?.(env)),
  }));
}

export async function collectLocalProviders(env = process.env, options = {}) {
  const automatic = new Set(enabledAdapters(env).map(adapter => adapter.id));
  const results = await Promise.all(providerAdapters.map(async adapter => {
    const { mode, env: sourceEnv, revision } = sourceConfiguration(adapter.id, options.desktop, env);
    if (mode === "off" || (mode !== "on" && !automatic.has(adapter.id))) {
      coordinators.delete(adapter.id);
      return [];
    }
    let cache = coordinators.get(adapter.id);
    if (cache?.revision !== revision) {
      cache = { revision, coordinator: createProviderRefreshCoordinator() };
      coordinators.set(adapter.id, cache);
    }
    return cache.coordinator.collect([adapter], sourceEnv, options);
  }));
  const providers = results.flat();
  return groupGrokSharedUsage(providers).map((result) => {
    const provider = { ...result };
    delete provider.sharedWeekStart;
    delete provider.cursorAccount;
    return provider;
  });
}
