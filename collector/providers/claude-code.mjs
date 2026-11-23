import { existsSync } from "node:fs";
import { hostname } from "node:os";
import {
  getClaudeOAuthUsage,
  planLabelFromSubscription,
  readClaudePlanName,
} from "../claude-oauth-usage.mjs";
import { readClaudeQuota } from "../claude-quota.mjs";
import {
  claudeProjectsDir,
  estimateClaudeSessionLogTokenEstimates,
} from "../claude-session-log.mjs";

const CLAUDE = {
  id: "claude",
  name: "Claude Code",
  shortName: "CL",
  accent: "#D97757",
};

function baseProvider(updatedAt) {
  return {
    id: CLAUDE.id,
    name: CLAUDE.name,
    shortName: CLAUDE.shortName,
    accent: CLAUDE.accent,
    plan: null,
    source: "Local Claude Code session logs",
    sourceKind: "session_logs",
    host: hostname(),
    updatedAt,
    windows: [],
    balance: null,
    tokenUsage: null,
    tokenEstimates: [],
  };
}

export async function collectClaudeCodeUsage(env = process.env) {
  const updatedAt = new Date().toISOString();
  const quotaPath = env.USAGE_HUB_CLAUDE_QUOTA_FILE?.trim();
  const quota = await readClaudeQuota(quotaPath);
  const hasLogs = existsSync(claudeProjectsDir(env));
  const provider = baseProvider(updatedAt);
  // The account endpoint is fresher than the status-line snapshot (which only
  // moves while a terminal session is open), so it wins when it answers.
  const oauth = await getClaudeOAuthUsage(env);
  const live = oauth?.ok && oauth.windows.length > 0 ? oauth : null;
  provider.plan =
    (await readClaudePlanName(env)) ??
    planLabelFromSubscription(oauth?.subscriptionType);
  if (live) {
    provider.windows = live.windows;
    provider.source = hasLogs
      ? "Claude usage endpoint and local logs"
      : "Claude usage endpoint";
    provider.sourceKind = "oauth_usage";
  } else if (quota) {
    provider.windows = quota.windows;
    provider.source = hasLogs
      ? "Claude Code status line and local logs"
      : "Claude Code status line";
  }
  const quotaMessage = live
    ? `Claude subscription quota read from the Claude usage endpoint at ${new Date(live.fetchedAt).toLocaleString()}.`
    : quota
    ? `Claude subscription quota captured by Claude Code at ${new Date(quota.capturedAt).toLocaleString()}.`
    : quotaPath
      ? "Waiting for subscription quota from a signed-in Claude Code session with the Usage Dashboard status line."
      : null;

  if (!hasLogs && !quota && !live) {
    return {
      ...provider,
      state: "needs_configuration",
      message:
        quotaMessage ??
        "Claude Code session logs not found on this machine. Run Claude Code once to create them, or set CLAUDE_CONFIG_DIR if its data directory is elsewhere.",
    };
  }

  try {
    const estimates = hasLogs ? await estimateClaudeSessionLogTokenEstimates(env) : [];
    return {
      ...provider,
      state: "ready",
      message: quotaMessage ?? (
        estimates.length === 0
          ? "No Claude Code token usage recorded on this machine in the last 7 days."
          : null
      ),
      tokenUsage:
        estimates.find((estimate) => estimate.periodId === "today") ||
        estimates[0] ||
        null,
      tokenEstimates: estimates,
    };
  } catch (error) {
    console.warn(
      `Claude Code session-log token estimate failed: ${error?.message || error}`,
    );
    return {
      ...provider,
      state: quota || live ? "ready" : "error",
      source: live ? "Claude usage endpoint" : quota ? "Claude Code status line" : provider.source,
      message: [
        quotaMessage,
        "Could not read the Claude Code session logs on this machine.",
      ].filter(Boolean).join(" "),
      retryable: true,
    };
  }
}

const FABLE = {
  id: "claude-fable",
  name: "Claude Fable",
  shortName: "CF",
  accent: "#D97757",
};

// Fable has its own weekly allowance inside the plan; it is reported only by
// the account usage endpoint, never by the status line.
export async function collectClaudeFableUsage(env = process.env) {
  const updatedAt = new Date().toISOString();
  const oauth = await getClaudeOAuthUsage(env);
  const base = {
    id: FABLE.id,
    name: FABLE.name,
    shortName: FABLE.shortName,
    accent: FABLE.accent,
    plan:
      (await readClaudePlanName(env)) ??
      planLabelFromSubscription(oauth?.subscriptionType),
    source: "Claude usage endpoint",
    sourceKind: "oauth_usage",
    host: hostname(),
    updatedAt,
    windows: [],
    balance: null,
    tokenUsage: null,
    tokenEstimates: [],
  };
  if (!oauth) {
    return {
      ...base,
      state: "needs_configuration",
      message: "Set USAGE_HUB_CLAUDE_OAUTH_USAGE=1 to read per-model Claude limits.",
    };
  }
  if (!oauth.ok) {
    return {
      ...base,
      state: oauth.reason === "no_credentials" ? "needs_configuration" : "error",
      message: oauth.message,
      retryable: oauth.reason !== "no_credentials",
    };
  }
  const fable = oauth.scoped.find((entry) => /fable/i.test(entry.model));
  if (!fable) {
    return {
      ...base,
      state: "needs_configuration",
      message: "This Claude account reports no separate Fable weekly limit.",
    };
  }
  return {
    ...base,
    state: "ready",
    updatedAt: oauth.fetchedAt ?? updatedAt,
    windows: [fable.window],
    message: "Separate weekly allowance for Fable inside the plan; not added to the Claude total.",
  };
}
