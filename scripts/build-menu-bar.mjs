import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "apps", "macos-menu-bar");
const appPath = join(root, "dist", "AI Usage Dashboard Menu Bar.app");
const contentsPath = join(appPath, "Contents");
const executablePath = join(contentsPath, "MacOS", "UsageMenuBar");

execFileSync(
  "swift",
  ["build", "-c", "release", "--package-path", packagePath],
  { cwd: root, stdio: "inherit" },
);

const binPath = execFileSync(
  "swift",
  [
    "build",
    "-c",
    "release",
    "--show-bin-path",
    "--package-path",
    packagePath,
  ],
  { cwd: root, encoding: "utf8" },
).trim();

await rm(appPath, { recursive: true, force: true });
await mkdir(join(contentsPath, "MacOS"), { recursive: true });
await copyFile(join(binPath, "UsageMenuBar"), executablePath);
await chmod(executablePath, 0o755);
await writeFile(
  join(contentsPath, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>AI Usage Dashboard</string>
  <key>CFBundleExecutable</key>
  <string>UsageMenuBar</string>
  <key>CFBundleIdentifier</key>
  <string>dev.aiusage.dashboard.menubar</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>AI Usage Dashboard Menu Bar</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.6.0</string>
  <key>CFBundleVersion</key>
  <string>6</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`,
  "utf8",
);

console.log(`Built ${appPath}`);
