import { existsSync } from "node:fs";
import { claudeProjectsDir } from "../claude-session-log.mjs";
import { collectClaudeCodeUsage } from "./claude-code.mjs";
import { collectCodexUsage } from "./codex.mjs";
import { collectDeepSeekBalance } from "./deepseek.mjs";
import { collectGitHubCopilotUsage } from "./github-copilot.mjs";
import { collectKimiUsage } from "./kimi.mjs";
import { collectOpenAIAdminUsage } from "./openai-api.mjs";
import { collectOpenRouterUsage } from "./openrouter.mjs";
import { createProviderRefreshCoordinator } from "../provider-refresh.mjs";

const refreshCoordinator = createProviderRefreshCoordinator();

export const providerAdapters = [
  {
    id: "codex",
    name: "OpenAI Codex",
    defaultEnabled: true,
    collect: collectCodexUsage,
  },
  {
    id: "claude",
    name: "Claude Code",
    defaultEnabled: false,
    // Auto-enables once local Claude Code session logs exist; no credential
    // is required, so log presence is the configuration signal.
    configured: (env) => existsSync(claudeProjectsDir(env)),
    collect: collectClaudeCodeUsage,
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
    id: "github-copilot",
    name: "GitHub Copilot",
    configured: (env) =>
      Boolean(
        env.GITHUB_COPILOT_TOKEN?.trim() &&
          env.GITHUB_COPILOT_USERNAME?.trim(),
      ),
    collect: collectGitHubCopilotUsage,
  },
];

function enabledAdapters(env) {
  const explicit = env.USAGE_HUB_PROVIDERS?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const selected = explicit?.length ? new Set(explicit) : null;
  return providerAdapters.filter((adapter) => {
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
  return refreshCoordinator.collect(enabledAdapters(env), env, options);
}
