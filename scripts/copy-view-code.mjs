import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const code = (await readFile(join(homedir(), ".usage-hub", "view-code"), "utf8")).trim();
if (!code) {
  console.error("View code has not been generated yet.");
  process.exit(1);
}
const result = spawnSync("pbcopy", [], {
  input: code,
  encoding: "utf8",
  stdio: ["pipe", "ignore", "inherit"],
});
if (result.status !== 0) process.exit(result.status || 1);
console.log("View code copied to the clipboard.");
