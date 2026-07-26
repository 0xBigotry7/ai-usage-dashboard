import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "apps", "macos-menu-bar");
const outputAppPath = join(
  root,
  "dist",
  "AI Usage Dashboard Menu Bar.app",
);
const stagingRoot = await mkdtemp(
  join(tmpdir(), "ai-usage-dashboard-menubar-"),
);
const swiftScratchPath = join(stagingRoot, "swift-build");
const appPath = join(stagingRoot, "AI Usage Dashboard Menu Bar.app");
const contentsPath = join(appPath, "Contents");
const executablePath = join(contentsPath, "MacOS", "UsageMenuBar");
const brandsSourcePath = join(root, "public", "brands");
const brandsDestinationPath = join(contentsPath, "Resources", "brands");
const collectorDestinationPath = join(
  contentsPath,
  "Resources",
  "collector",
);
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const version = String(packageJson.version);
const dashboardURL =
  process.env.USAGE_HUB_DASHBOARD_URL?.trim() ||
  "http://localhost:3000";
if (!/^\d+(?:\.\d+){0,2}$/.test(version)) {
  throw new Error(`package.json contains an invalid app version: ${version}`);
}
if (!/^https?:\/\/[^<>"\s]+$/.test(dashboardURL)) {
  throw new Error("USAGE_HUB_DASHBOARD_URL must be an HTTP(S) URL");
}

execFileSync(
  "swift",
  [
    "build",
    "-c",
    "release",
    "--package-path",
    packagePath,
    "--scratch-path",
    swiftScratchPath,
  ],
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
    "--scratch-path",
    swiftScratchPath,
  ],
  { cwd: root, encoding: "utf8" },
).trim();

await rm(appPath, { recursive: true, force: true });
await mkdir(join(contentsPath, "MacOS"), { recursive: true });
await copyFile(join(binPath, "UsageMenuBar"), executablePath);
await chmod(executablePath, 0o755);

const brandFiles = (await readdir(brandsSourcePath))
  .filter((file) => file.endsWith(".svg"))
  .sort();
if (brandFiles.length === 0) {
  throw new Error("No SVG provider logos found in public/brands");
}
await mkdir(brandsDestinationPath, { recursive: true });
await Promise.all(
  brandFiles.map((file) =>
    copyFile(
      join(brandsSourcePath, file),
      join(brandsDestinationPath, file),
    ),
  ),
);
await cp(join(root, "collector"), collectorDestinationPath, {
  recursive: true,
});
await copyFile(
  join(root, "package.json"),
  join(contentsPath, "Resources", "package.json"),
);

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
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>UsageHubDashboardURL</key>
  <string>${dashboardURL
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</string>
</dict>
</plist>
`,
  "utf8",
);

execFileSync("xattr", ["-cr", appPath], {
  cwd: root,
  stdio: "inherit",
});
execFileSync(
  "codesign",
  ["--force", "--deep", "--sign", "-", appPath],
  { cwd: root, stdio: "inherit" },
);
execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
  cwd: root,
  stdio: "inherit",
});

await rm(outputAppPath, { recursive: true, force: true });
await mkdir(dirname(outputAppPath), { recursive: true });
execFileSync("ditto", [appPath, outputAppPath], {
  cwd: root,
  stdio: "inherit",
});
await rm(stagingRoot, { recursive: true, force: true });

console.log(
  `Built ${outputAppPath} (${version}, ${brandFiles.length} provider logos)`,
);
