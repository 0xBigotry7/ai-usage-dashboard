#!/usr/bin/env node
/**
 * ai-usage-hub CLI.
 *
 * Commands:
 *   start (default)  Run the local collector and the prebuilt web dashboard.
 *   collector        Run only the local collector.
 *   menubar          macOS: install and launch the bundled menu bar app.
 *   configure        Save optional provider credentials or a token-capacity
 *                    calibration to ~/.usage-hub/env.
 *
 * Dependency-free by design: node builtins only, plus the vinext production
 * server (a runtime dependency of this package) loaded lazily by
 * bin/dashboard-server.mjs after the Node version preflight has passed.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  CONFIGURE_TARGETS,
  MINIMUM_NODE_VERSION,
  compareVersions,
  meetsNodeRequirement,
  parseCliArgs,
} from "./cli-args.mjs";
import {
  runConfigureCapacity,
  runConfigureKimi,
  runConfigureProvider,
} from "./configure-lib.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pkg = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

if (!meetsNodeRequirement(process.versions.node, MINIMUM_NODE_VERSION)) {
  console.error(
    `ai-usage-hub requires Node.js >= ${MINIMUM_NODE_VERSION}, ` +
      `but this is Node.js ${process.versions.node}.\n` +
      "Install a newer Node.js from https://nodejs.org and try again.",
  );
  process.exit(1);
}

const HELP = `ai-usage-hub ${pkg.version}
A local-first AI quota, API usage, and token dashboard.

Usage:
  ai-usage-hub [command] [options]

Commands:
  start        Run the local collector and the web dashboard, then open the
               browser. This is the default when no command is given.
  collector    Run only the local usage collector (HTTP API on port 4317).
  menubar      macOS only: install the bundled menu bar app into
               ~/Applications (first run or version upgrade) and launch it.
  configure    Save optional provider credentials to ~/.usage-hub/env
               (mode 0600, secrets prompted without echo):
                 ai-usage-hub configure kimi
                 ai-usage-hub configure openai-api   (or openrouter,
                                                     deepseek, github-copilot)
                 ai-usage-hub configure capacity <codex|kimi> <tokens|clear>

Options:
  -h, --help       Show this help.
  -v, --version    Print the package version.

Environment:
  PORT                    Dashboard HTTP port (default 3000). The browser
                          client expects the collector CORS allowlist, which
                          covers port 3000; prefer the default.
  HOST                    Dashboard bind address (default 127.0.0.1).
  USAGE_HUB_PORT          Collector HTTP port (default 4317).
  USAGE_HUB_HOST          Collector bind address (default 127.0.0.1).

Credentials never leave this machine; the collector and dashboard bind to
localhost by default.`;

function launchManaged(children, state, name, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: packageRoot,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (!state.stopping) {
      console.error(
        `[ai-usage-hub] ${name} exited unexpectedly (${signal || code}); shutting down.`,
      );
      stopAll(children, state, code || 1);
    }
  });
  children.push(child);
  return child;
}

function stopAll(children, state, exitCode) {
  if (state.stopping) return;
  state.stopping = true;
  for (const child of children) child.kill("SIGTERM");
  // Give children a moment to flush and exit before the parent leaves.
  setTimeout(() => process.exit(exitCode), 500).unref();
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status > 0) return true;
    } catch {
      // Server not accepting connections yet.
    }
    await sleep(250);
  }
  return false;
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    console.log(`Could not open a browser automatically; visit ${url}`);
  });
  child.unref();
}

async function runStart() {
  const dashboardPort = Number(process.env.PORT || 3000);
  const collectorPort = Number(process.env.USAGE_HUB_PORT || 4317);
  const children = [];
  const state = { stopping: false };

  process.on("SIGINT", () => stopAll(children, state, 0));
  process.on("SIGTERM", () => stopAll(children, state, 0));

  launchManaged(children, state, "collector", [
    "--enable-source-maps",
    path.join(packageRoot, "collector", "server.mjs"),
  ]);
  launchManaged(children, state, "dashboard", [
    path.join(packageRoot, "bin", "dashboard-server.mjs"),
  ]);

  const url = `http://localhost:${dashboardPort}`;
  // Probe the concrete bind address, not `localhost`: on dual-stack hosts
  // another process on [::1] must not satisfy our readiness check.
  const probeHost = process.env.HOST || "127.0.0.1";
  const ready = await waitForHttp(`http://${probeHost}:${dashboardPort}`, 30_000);
  if (state.stopping) return;
  if (ready) {
    console.log(`\n  AI Usage Dashboard: ${url}`);
    console.log(`  Collector API:      http://127.0.0.1:${collectorPort}\n`);
    console.log("  Press Ctrl-C to stop.\n");
    openBrowser(url);
  } else {
    console.error(
      `[ai-usage-hub] Dashboard did not answer on ${url} within 30s; ` +
        "it may still be starting. Check the log output above.",
    );
  }
}

function runCollectorOnly() {
  const child = spawn(
    process.execPath,
    ["--enable-source-maps", path.join(packageRoot, "collector", "server.mjs")],
    { cwd: packageRoot, env: process.env, stdio: "inherit" },
  );
  // Forward termination signals so the collector also dies when only the
  // CLI process is signalled (Ctrl-C additionally reaches the child via the
  // shared process group).
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  // Mirror the child's exit so scripted callers observe its status.
  child.on("exit", (code, signal) => {
    process.exit(signal ? 0 : (code ?? 0));
  });
}

function readInstalledAppVersion(appPath) {
  try {
    const plist = readFileSync(
      path.join(appPath, "Contents", "Info.plist"),
      "utf8",
    );
    const match = plist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    );
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function runMenubar() {
  if (process.platform !== "darwin") {
    console.error(
      "The menu bar app is macOS-only (prebuilt for Apple Silicon).\n" +
        'On this platform, run "ai-usage-hub" to use the web dashboard.',
    );
    process.exit(1);
  }
  const zipPath = path.join(packageRoot, "prebuilt", "menubar.zip");
  if (!existsSync(zipPath)) {
    console.error(
      "This install does not bundle the prebuilt menu bar app " +
        `(missing ${zipPath}).\n` +
        "From a source checkout, build it with: npm run prebuilt:menubar",
    );
    process.exit(1);
  }

  const applicationsDir = path.join(homedir(), "Applications");
  const appPath = path.join(applicationsDir, "AI Usage Dashboard Menu Bar.app");
  const installedVersion = readInstalledAppVersion(appPath);

  if (installedVersion && compareVersions(installedVersion, pkg.version) >= 0) {
    console.log(
      `Menu bar app ${installedVersion} is already installed at ${appPath}.`,
    );
  } else {
    console.log(
      installedVersion
        ? `Upgrading menu bar app ${installedVersion} -> ${pkg.version} in ${applicationsDir}...`
        : `Installing menu bar app ${pkg.version} into ${applicationsDir}...`,
    );
    mkdirSync(applicationsDir, { recursive: true });
    rmSync(appPath, { recursive: true, force: true });
    // ditto preserves the ad-hoc code signature; the zip contains the .app
    // as its single top-level entry.
    execFileSync("/usr/bin/ditto", ["-x", "-k", zipPath, applicationsDir], {
      stdio: "inherit",
    });
  }

  execFileSync("/usr/bin/open", [appPath], { stdio: "inherit" });
  console.log(
    "Menu bar app launched; look for the usage icon in the macOS menu bar.",
  );
}

async function runConfigure(commandArgs) {
  const [target, ...rest] = commandArgs;
  const normalized = target?.trim().toLowerCase();
  if (!normalized || !CONFIGURE_TARGETS.includes(normalized)) {
    console.error(
      "Usage: ai-usage-hub configure <kimi|openai-api|openrouter|deepseek|github-copilot>",
    );
    console.error(
      "       ai-usage-hub configure capacity <codex|kimi> <weekly token capacity|clear>",
    );
    process.exit(2);
  }
  if (normalized === "kimi") {
    process.exit(
      await runConfigureKimi({ commandHint: '"ai-usage-hub configure kimi"' }),
    );
  }
  if (normalized === "capacity") {
    process.exit(
      await runConfigureCapacity(rest[0], rest[1], {
        usageCommand:
          "ai-usage-hub configure capacity <codex|kimi> <weekly token capacity|clear>",
      }),
    );
  }
  process.exit(
    await runConfigureProvider(normalized, {
      exampleCommand: "ai-usage-hub configure openrouter",
    }),
  );
}

const args = parseCliArgs(process.argv.slice(2));
if (args.error) {
  console.error(`ai-usage-hub: ${args.error}`);
  console.error('Run "ai-usage-hub --help" for usage.');
  process.exit(2);
}
if (args.version) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

if (args.command === "start") {
  await runStart();
} else if (args.command === "collector") {
  runCollectorOnly();
} else if (args.command === "menubar") {
  runMenubar();
} else if (args.command === "configure") {
  await runConfigure(args.commandArgs);
}
