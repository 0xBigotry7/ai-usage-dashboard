import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";

const providerAliases = {
  openai: "openai-api",
  copilot: "github-copilot",
};

const providerConfigs = {
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

if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
  console.error("Run this configuration command in an interactive terminal.");
  process.exit(1);
}

const rawProvider = process.argv[2]?.trim().toLowerCase();
const providerId = providerAliases[rawProvider] || rawProvider;
const config = providerConfigs[providerId];

if (!config) {
  console.error(
    "Choose a provider: openai-api, openrouter, deepseek, or github-copilot.",
  );
  console.error("Example: npm run configure:provider -- openrouter");
  process.exit(1);
}

function readInput(label, { secret = false, optional = false } = {}) {
  stdout.write(
    `${label}${optional ? " (optional)" : ""}${secret ? " (input hidden)" : ""}: `,
  );
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    let value = "";

    function finish() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      resolve(value.trim());
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

const directory = join(homedir(), ".usage-hub");
const envPath = join(directory, "env");
await mkdir(directory, { recursive: true, mode: 0o700 });

let existing = "";
try {
  existing = await readFile(envPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const values = new Map();
for (const rawLine of existing.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator <= 0) continue;
  values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
}

console.log(
  `Configuring ${config.name}. Credentials are written only to ~/.usage-hub/env.`,
);
for (const field of config.fields) {
  const value = await readInput(field.label, field);
  if (!value && !field.optional) {
    console.error(`${field.label} cannot be empty; configuration unchanged.`);
    process.exit(1);
  }
  if (value) values.set(field.key, value);
}

const serialized = `${Array.from(
  values,
  ([name, value]) => `${name}=${value}`,
).join("\n")}\n`;
await writeFile(envPath, serialized, {
  encoding: "utf8",
  mode: 0o600,
});
await chmod(envPath, 0o600);

console.log(
  `${config.name} configured. Restart the local collector and it will appear on the dashboard automatically.`,
);
