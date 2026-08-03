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

const capacityKeys = {
  codex: "USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY",
  kimi: "USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY",
};

const provider = process.argv[2]?.trim().toLowerCase();
const rawCapacity = process.argv[3]?.trim();
const capacityKey = capacityKeys[provider];

if (!capacityKey || !rawCapacity) {
  console.error(
    "Usage: npm run configure:capacity -- <codex|kimi> <weekly token capacity|clear>",
  );
  process.exit(1);
}

const shouldClear = rawCapacity.toLowerCase() === "clear";
const capacity = Number(rawCapacity);
if (!shouldClear && (!Number.isSafeInteger(capacity) || capacity <= 0)) {
  console.error(
    "Weekly token capacity must be a positive integer, or use clear to remove the calibration.",
  );
  process.exit(1);
}

const configuredEnvPath = process.env.USAGE_HUB_ENV_FILE?.trim();
const envPath = configuredEnvPath
  ? resolve(configuredEnvPath)
  : join(homedir(), ".usage-hub", "env");
const directory = dirname(envPath);
await mkdir(directory, { recursive: true, mode: 0o700 });

let existing = "";
try {
  existing = await readFile(envPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

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
const tempPath = join(
  directory,
  `.env.${process.pid}.${randomUUID()}.tmp`,
);
try {
  await writeFile(tempPath, serialized, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, envPath);
} finally {
  try {
    await unlink(tempPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

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
