import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const code = (await readFile(join(homedir(), ".usage-hub", "view-code"), "utf8")).trim();
if (!code) {
  console.error("查看码尚未生成。");
  process.exit(1);
}
const result = spawnSync("pbcopy", [], {
  input: code,
  encoding: "utf8",
  stdio: ["pipe", "ignore", "inherit"],
});
if (result.status !== 0) process.exit(result.status || 1);
console.log("查看码已复制到剪贴板。");
