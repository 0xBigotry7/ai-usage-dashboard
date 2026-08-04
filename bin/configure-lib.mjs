/**
 * Shared implementation of the interactive provider-configuration flows.
 *
 * Lives in bin/ (not scripts/) so the published npm package ships it: the
 * `ai-usage-hub configure` subcommand (bin/cli.mjs) and the source-checkout
 * scripts (scripts/configure-*.mjs) both import these helpers, so npx users
 * and repo users run exactly the same logic.
 *
 * Invariants shared by every flow:
 * - secrets are read through a non-echoing prompt;
 * - values are written only to ~/.usage-hub/env (or USAGE_HUB_ENV_FILE for
 *   the capacity flow) with file mode 0600 via an atomic rename;
 * - each flow returns a process exit code instead of exiting, so callers
 *   decide how to terminate.
 */
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";

export const PROVIDER_ALIASES = {
  openai: "openai-api",
  copilot: "github-copilot",
};

export const PROVIDER_CONFIGS = {
  "openai-api": {
    name: "OpenAI API",
    fields: [
      {
        key: "OPENAI_ADMIN_KEY",
        label: "OpenAI Admin API Key",
        secret: true,
      },
    ],
  },
  openrouter: {
    name: "OpenRouter",
    fields: [
      {
        key: "OPENROUTER_API_KEY",
        label: "OpenRouter API Key",
        secret: true,
      },
    ],
  },
  deepseek: {
    name: "DeepSeek API",
    fields: [
      {
        key: "DEEPSEEK_API_KEY",
        label: "DeepSeek API Key",
        secret: true,
      },
    ],
  },
  "github-copilot": {
    name: "GitHub Copilot",
    fields: [
      {
        key: "GITHUB_COPILOT_USERNAME",
        label: "GitHub username",
        secret: false,
      },
      {
        key: "GITHUB_COPILOT_TOKEN",
        label: "Fine-grained token (Plan: read)",
        secret: true,
      },
      {
        key: "GITHUB_COPILOT_MONTHLY_CREDIT_LIMIT",
        label: "Monthly AI credits limit (optional)",
        secret: false,
        optional: true,
      },
    ],
  },
};

export const CAPACITY_KEYS = {
  codex: "USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY",
  kimi: "USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY",
};

export function stdinIsInteractive() {
  return Boolean(stdin.isTTY) && typeof stdin.setRawMode === "function";
}

/**
 * Prompt on the controlling terminal. Secret fields are never echoed;
 * non-secret fields echo per keystroke and support backspace. Ctrl-C exits
 * the process with the conventional 130.
 */
export function readInput(label, { secret = false, optional = false } = {}) {
  stdout.write(
    `${label}${optional ? " (optional)" : ""}${secret ? " (input hidden)" : ""}: `,
  );
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolvePromise) => {
    let value = "";

    function finish() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      resolvePromise(value.trim());
    }

    function onData(chunk) {
      for (const character of chunk) {
        if (character === "\u0003") {
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            if (!secret) stdout.write("\b \b");
          }
          continue;
        }
        if (character < " ") continue;
        value += character;
        if (!secret) stdout.write(character);
      }
    }

    stdin.on("data", onData);
  });
}

export function defaultEnvPath() {
  return join(homedir(), ".usage-hub", "env");
}

async function readExistingEnv(envPath) {
  try {
    return await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return "";
  }
}

export function parseEnvValues(contents) {
  const values = new Map();
  for (const rawLine of String(contents ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }
  return values;
}

/**
 * Write the env file with owner-only permissions via temp file + atomic
 * rename, so a crash can never leave a partially written credential file.
 */
async function writeEnvFileAtomic(envPath, serialized) {
  const directory = dirname(envPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = join(directory, `.env.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, envPath);
  } finally {
    try {
      await unlink(tempPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await chmod(envPath, 0o600);
}

async function saveEnvValues(envPath, values) {
  const serialized = `${Array.from(
    values,
    ([name, value]) => `${name}=${value}`,
  ).join("\n")}\n`;
  await writeEnvFileAtomic(envPath, serialized);
}

/**
 * Interactive flow for the Kimi Code API key. Returns a process exit code.
 */
export async function runConfigureKimi({
  commandHint = "this configuration command",
} = {}) {
  if (!stdinIsInteractive()) {
    console.error(`Run ${commandHint} in an interactive terminal.`);
    return 1;
  }

  const key = await readInput("Paste your Kimi Code API key", { secret: true });
  if (!key) {
    console.error("No API key received; configuration unchanged.");
    return 1;
  }

  const envPath = defaultEnvPath();
  const values = parseEnvValues(await readExistingEnv(envPath));
  values.set("KIMI_CODE_API_KEY", key);
  await saveEnvValues(envPath, values);
  console.log(
    "Kimi Code API key saved. Wait for the next automatic refresh, or click Refresh on the dashboard.",
  );
  return 0;
}

/**
 * Interactive flow for API-key providers (openai-api, openrouter, deepseek,
 * github-copilot, plus aliases). Returns a process exit code.
 */
export async function runConfigureProvider(
  rawProvider,
  { exampleCommand = "npm run configure:provider -- openrouter" } = {},
) {
  const normalized = rawProvider?.trim().toLowerCase();
  const providerId = PROVIDER_ALIASES[normalized] || normalized;
  const config = PROVIDER_CONFIGS[providerId];

  if (!config) {
    console.error(
      "Choose a provider: openai-api, openrouter, deepseek, or github-copilot.",
    );
    console.error(`Example: ${exampleCommand}`);
    return 1;
  }

  if (!stdinIsInteractive()) {
    console.error("Run this configuration command in an interactive terminal.");
    return 1;
  }

  const envPath = defaultEnvPath();
  const values = parseEnvValues(await readExistingEnv(envPath));

  console.log(
    `Configuring ${config.name}. Credentials are written only to ~/.usage-hub/env.`,
  );
  for (const field of config.fields) {
    const value = await readInput(field.label, field);
    if (!value && !field.optional) {
      console.error(`${field.label} cannot be empty; configuration unchanged.`);
      return 1;
    }
    if (value) values.set(field.key, value);
  }

  await saveEnvValues(envPath, values);
  console.log(
    `${config.name} configured. Restart the local collector and it will appear on the dashboard automatically.`,
  );
  return 0;
}

/**
 * Non-interactive flow recording a weekly token-capacity calibration.
 * Preserves comments and unrelated lines in the env file. Returns a process
 * exit code.
 */
export async function runConfigureCapacity(
  rawProvider,
  rawCapacity,
  {
    usageCommand = "npm run configure:capacity -- <codex|kimi> <weekly token capacity|clear>",
    env = process.env,
  } = {},
) {
  const provider = rawProvider?.trim().toLowerCase();
  const capacityValue = rawCapacity?.trim();
  const capacityKey = CAPACITY_KEYS[provider];

  if (!capacityKey || !capacityValue) {
    console.error(`Usage: ${usageCommand}`);
    return 1;
  }

  const shouldClear = capacityValue.toLowerCase() === "clear";
  const capacity = Number(capacityValue);
  if (!shouldClear && (!Number.isSafeInteger(capacity) || capacity <= 0)) {
    console.error(
      "Weekly token capacity must be a positive integer, or use clear to remove the calibration.",
    );
    return 1;
  }

  const configuredEnvPath = env.USAGE_HUB_ENV_FILE?.trim();
  const envPath = configuredEnvPath
    ? resolve(configuredEnvPath)
    : defaultEnvPath();

  const existing = await readExistingEnv(envPath);
  const assignmentPattern = new RegExp(
    `^\\s*${capacityKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
  );
  const lines = existing ? existing.split(/\r?\n/) : [];
  const nextLines = [];
  let wroteCapacity = false;
  for (const line of lines) {
    if (!assignmentPattern.test(line)) {
      nextLines.push(line);
      continue;
    }
    if (!shouldClear && !wroteCapacity) {
      nextLines.push(`${capacityKey}=${capacity}`);
      wroteCapacity = true;
    }
  }
  if (!shouldClear && !wroteCapacity) {
    while (nextLines.at(-1) === "") nextLines.pop();
    nextLines.push(`${capacityKey}=${capacity}`);
  }
  while (nextLines.at(-1) === "") nextLines.pop();
  const serialized = nextLines.length ? `${nextLines.join("\n")}\n` : "";
  await writeEnvFileAtomic(envPath, serialized);

  if (shouldClear) {
    console.log(`Weekly token capacity calibration cleared for ${provider}.`);
  } else {
    console.log(
      `Weekly token capacity calibration for ${provider} set to ${capacity.toLocaleString("en-US")}.`,
    );
  }
  console.log(
    "Takes effect after the local collector restarts. This value is a display calibration, not an official subscription limit.",
  );
  return 0;
}
