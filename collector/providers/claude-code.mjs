import { existsSync } from "node:fs";
import { hostname } from "node:os";
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
    // Claude Code exposes no documented quota endpoint. Observed local tokens
    // are the only trustworthy signal, so no quota windows, reset times, or
    // percentages are fabricated from them.
    windows: [],
    balance: null,
    tokenUsage: null,
    tokenEstimates: [],
  };
}

export async function collectClaudeCodeUsage(env = process.env) {
  const updatedAt = new Date().toISOString();
  const provider = baseProvider(updatedAt);

  if (!existsSync(claudeProjectsDir(env))) {
    return {
      ...provider,
      state: "needs_configuration",
      message:
        "Claude Code session logs not found on this machine. Run Claude Code once to create them, or set CLAUDE_CONFIG_DIR if its data directory is elsewhere.",
    };
  }

  try {
    const estimates = await estimateClaudeSessionLogTokenEstimates(env);
    return {
      ...provider,
      state: "ready",
      message:
        estimates.length === 0
          ? "No Claude Code token usage recorded on this machine in the last 7 days."
          : null,
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
      state: "error",
      message: "Could not read the Claude Code session logs on this machine.",
      retryable: true,
    };
  }
}
