import { stdin, stdout } from "node:process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
  console.error("请在交互式终端中运行 npm run configure:kimi。");
  process.exit(1);
}

function readSecret(prompt) {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    let secret = "";
    function finish() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      resolve(secret.trim());
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
          secret = secret.slice(0, -1);
          continue;
        }
        secret += character;
      }
    }
    stdin.on("data", onData);
  });
}

const key = await readSecret("粘贴 Kimi Code API Key（输入内容隐藏）：");

if (!key) {
  console.error("没有收到 API Key，未修改配置。");
  process.exit(1);
}

const directory = join(homedir(), ".usage-hub");
const path = join(directory, "env");
await mkdir(directory, { recursive: true, mode: 0o700 });

let existing = "";
try {
  existing = await readFile(path, "utf8");
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
values.set("KIMI_CODE_API_KEY", key);

const serialized = `${Array.from(values, ([name, value]) => `${name}=${value}`).join("\n")}\n`;
await writeFile(path, serialized, {
  encoding: "utf8",
  mode: 0o600,
});
await chmod(path, 0o600);
console.log("Kimi Code API Key 已保存。等待下一次自动刷新，或在 Dashboard 点击刷新。");
