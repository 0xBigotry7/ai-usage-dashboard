import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Renders only this app's synthetic demo view, never the desktop or live data.
if (process.platform !== "darwin") throw new Error("Preview rendering requires macOS");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "docs/images/menu-bar-overview.png");
mkdirSync(dirname(output), { recursive: true });
execFileSync("swift", ["build", "-c", "release", "--package-path", "apps/macos-menu-bar"], {
  cwd: root, stdio: "inherit",
});
const bin = execFileSync("swift", ["build", "-c", "release", "--package-path", "apps/macos-menu-bar", "--show-bin-path"], {
  cwd: root, encoding: "utf8",
}).trim();
execFileSync(resolve(bin, "UsageMenuBar"), ["--demo", "--demo-export", output], {
  cwd: root, stdio: "inherit", timeout: 30_000,
});
if (!existsSync(output)) throw new Error("Demo preview export did not produce an image");
console.log("Saved synthetic native preview: docs/images/menu-bar-overview.png");
