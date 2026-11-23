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

const FABLE = {
  id: "claude-fable",
  name: "Claude Fable",
  shortName: "CF",
  accent: "#D97757",
};

const LOGS_SOURCE = "Local Claude Code session logs";
const ENDPOINT_SOURCE = "Claude usage endpoint";
const STATUS_LINE_SOURCE = "Claude Code status line";

function baseProvider(identity, plan) {
  return {
    id: identity.id,
    name: identity.name,
    shortName: identity.shortName,
    accent: identity.accent,
    plan,
    host: hostname(),
    windows: [],
    balance: null,
    tokenUsage: null,
    tokenEstimates: [],
  };
}

async function planName(env, oauth) {
  return (await readClaudePlanName(env)) ?? planLabelFromSubscription(oauth?.subscriptionType);
}

// A lapsed or missing sign-in is not a fault that a quick retry can clear, so
// only network and server trouble is marked retryable.
function oauthFailure(oauth) {
  const signIn = ["expired", "http_401", "http_403"].includes(oauth.reason);
  const unconfigured = oauth.reason === "no_credentials";
  return {
    state: unconfigured ? "needs_configuration" : signIn ? "auth_error" : "error",
    message: oauth.message,
    retryable: !signIn && !unconfigured,
  };
}

// Picks the subscription reading to show and records when it was taken. The
// account endpoint wins when it answers; the status-line snapshot only moves
// while a terminal session is open, so it is the fallback. `readAt` becomes
// the card's `updatedAt`, which is what the dashboards use to mark a reading
// as stale, so it must be the time of the reading and never the time of the
// poll.
function subscriptionQuota(oauth, snapshot) {
  if (oauth?.ok && oauth.windows.length > 0) {
    return {
      windows: oauth.windows,
      readAt: oauth.fetchedAt,
      source: ENDPOINT_SOURCE,
      sourceKind: "oauth_usage",
      note: null,
    };
  }
  const unavailable = oauth && !oauth.ok ? oauth.message : null;
  if (snapshot) {
    return {
      windows: snapshot.windows,
      readAt: snapshot.capturedAt,
      source: STATUS_LINE_SOURCE,
      sourceKind: "status_line",
      note: unavailable && `${unavailable} Showing the last status-line reading.`,
    };
  }
  return { windows: [], readAt: null, source: null, sourceKind: "session_logs", note: unavailable };
}

export async function collectClaudeCodeUsage(env = process.env) {
  const quotaPath = env.USAGE_HUB_CLAUDE_QUOTA_FILE?.trim();
  const [oauth, snapshot] = await Promise.all([
    getClaudeOAuthUsage(env),
    readClaudeQuota(quotaPath),
  ]);
  const quota = subscriptionQuota(oauth, snapshot);
  const hasQuota = quota.windows.length > 0;
  const hasLogs = existsSync(claudeProjectsDir(env));
  const provider = {
    ...baseProvider(CLAUDE, await planName(env, oauth)),
    source: !quota.source
      ? LOGS_SOURCE
      : hasLogs ? `${quota.source} and local logs` : quota.source,
    sourceKind: quota.sourceKind,
    updatedAt: quota.readAt ?? new Date().toISOString(),
    windows: quota.windows,
  };
  const waiting = !hasQuota && quotaPath
    ? "Waiting for subscription quota from a signed-in Claude Code session with the Usage Dashboard status line."
    : null;

  if (!hasLogs && !hasQuota) {
    return {
      ...provider,
      state: oauth && !oauth.ok ? oauthFailure(oauth).state : "needs_configuration",
      message:
        quota.note ??
        waiting ??
        "Claude Code session logs not found on this machine. Run Claude Code once to create them, or set CLAUDE_CONFIG_DIR if its data directory is elsewhere.",
    };
  }

  try {
    const estimates = hasLogs ? await estimateClaudeSessionLogTokenEstimates(env) : [];
    return {
      ...provider,
      state: "ready",
      message: quota.note ?? waiting ?? (
        !hasQuota && estimates.length === 0
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
      state: hasQuota ? "ready" : "error",
      source: quota.source ?? provider.source,
      message: [
        quota.note,
        "Could not read the Claude Code session logs on this machine.",
      ].filter(Boolean).join(" "),
      retryable: true,
    };
  }
}

// Fable has its own weekly allowance inside the plan; it is reported only by
// the account usage endpoint, never by the status line.
export async function collectClaudeFableUsage(env = process.env) {
  const oauth = await getClaudeOAuthUsage(env);
  const base = {
    ...baseProvider(FABLE, await planName(env, oauth)),
    source: ENDPOINT_SOURCE,
    sourceKind: "oauth_usage",
    updatedAt: oauth?.fetchedAt ?? new Date().toISOString(),
  };
  if (!oauth) {
    return {
      ...base,
      state: "needs_configuration",
      message: "Set USAGE_HUB_CLAUDE_OAUTH_USAGE=1 to read per-model Claude limits.",
    };
  }
  if (!oauth.ok) return { ...base, ...oauthFailure(oauth) };
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
    windows: [fable.window],
    message: "Separate weekly allowance for Fable inside the plan; not added to the Claude total.",
  };
}
