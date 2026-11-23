import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnvAssignment } from "./shared.mjs";

// The private env file may set only these keys; anything else in it is
// ignored so a stray line cannot change PATH, HOME or Node behaviour.
const PRIVATE_ENV_KEYS = new Set([
  "USAGE_HUB_MUSE_FILE",
  "DEEPSEEK_API_KEY",
  "GITHUB_COPILOT_MONTHLY_CREDIT_LIMIT",
  "GITHUB_COPILOT_TOKEN",
  "GITHUB_COPILOT_USERNAME",
  "KIMI_CODE_API_KEY",
  "KIMI_CODE_BASE_URL",
  "OPENAI_ADMIN_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_GO_API_KEY",
  "USAGE_HUB_DISABLE_PROVIDERS",
  "USAGE_HUB_PROVIDERS",
  "USAGE_HUB_PUSH_TOKEN",
  "USAGE_HUB_PUSH_URL",
  "USAGE_HUB_CLOUD_URL",
  "USAGE_HUB_VIEW_CODE_FILE",
  "USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY",
  "USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY",
  "USAGE_HUB_CODEX_LOG_ESTIMATE",
  "USAGE_HUB_CLAUDE_LOG_ESTIMATE",
  "USAGE_HUB_CLAUDE_QUOTA_FILE",
  "USAGE_HUB_CLAUDE_OAUTH_USAGE",
  "USAGE_HUB_CLAUDE_BIN",
  "USAGE_HUB_GROK_BIN",
  "USAGE_HUB_CURSOR_DESKTOP",
  "USAGE_HUB_CURSOR_DB",
  "USAGE_HUB_AGY_BIN",
]);

// Per environment object: the values it held before the file overrode them,
// so a line removed from the file takes effect on the next reload instead of
// at the next restart.
const overriddenValues = new WeakMap();
const warnedPushMismatch = new WeakSet();

function pushConfiguration(env, overridden) {
  const url = env.USAGE_HUB_PUSH_URL?.trim();
  const token = env.USAGE_HUB_PUSH_TOKEN?.trim();
  const fileUrl = overridden.has("USAGE_HUB_PUSH_URL");
  const fileToken = overridden.has("USAGE_HUB_PUSH_TOKEN");
  if (url && token && fileUrl !== fileToken) {
    if (!warnedPushMismatch.has(env)) {
      console.warn("Cloud sync skipped: USAGE_HUB_PUSH_URL and USAGE_HUB_PUSH_TOKEN must come from the same source.");
      warnedPushMismatch.add(env);
    }
    return null;
  }
  warnedPushMismatch.delete(env);
  return url && token ? { url, token } : null;
}

// Shared by the collector and the Claude status-line helper so both resolve
// the same settings from the same file.
export async function loadPrivateEnvironment(env = process.env) {
  const overridden = overriddenValues.get(env) ?? new Map();
  const path = env.USAGE_HUB_ENV_FILE || join(homedir(), ".usage-hub", "env");
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Cannot read private env file: ${error.message}`);
      return pushConfiguration(env, overridden);
    }
    contents = "";
  }
  overriddenValues.set(env, overridden);
  const present = new Set();
  for (const rawLine of contents.split(/\r?\n/)) {
    const assignment = parseEnvAssignment(rawLine);
    if (!assignment || !PRIVATE_ENV_KEYS.has(assignment.key)) continue;
    if (!overridden.has(assignment.key)) overridden.set(assignment.key, env[assignment.key]);
    env[assignment.key] = assignment.value;
    present.add(assignment.key);
  }
  for (const [key, original] of overridden) {
    if (present.has(key)) continue;
    if (original === undefined) delete env[key];
    else env[key] = original;
    overridden.delete(key);
  }
  return pushConfiguration(env, overridden);
}
