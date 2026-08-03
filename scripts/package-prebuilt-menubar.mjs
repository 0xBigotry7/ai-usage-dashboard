/**
 * Build the macOS menu bar app and bundle it as prebuilt/menubar.zip, the
 * path shipped inside the npm package (`ai-usage-dashboard menubar` unzips
 * it into ~/Applications).
 *
 * macOS + Xcode toolchain required (swift build). The GitHub release
 * workflow runs the equivalent flow on macos-latest before `npm publish`;
 * macOS arm64 is the only prebuilt target — other platforms use the web
 * dashboard.
 */
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("The menu bar app can only be built on macOS.");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = join(root, "dist", "AI Usage Dashboard Menu Bar.app");
const zipPath = join(root, "prebuilt", "menubar.zip");

execFileSync(process.execPath, [join(root, "scripts", "build-menu-bar.mjs")], {
  cwd: root,
  stdio: "inherit",
});

await mkdir(dirname(zipPath), { recursive: true });
await rm(zipPath, { force: true });
execFileSync(
  "/usr/bin/ditto",
  ["--norsrc", "-c", "-k", "--keepParent", appPath, zipPath],
  { cwd: root, stdio: "inherit" },
);

// Keep dist/ web-only: the .app must not be shipped twice in the npm tarball.
await rm(appPath, { recursive: true, force: true });

console.log(`Wrote ${zipPath}`);
