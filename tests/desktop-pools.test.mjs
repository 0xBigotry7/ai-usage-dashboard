import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadPrivateEnvironment } from "../collector/private-env.mjs";
import { sourceConfiguration, widgetSnapshot } from "../collector/desktop-preferences.mjs";
import { groupGrokSharedUsage } from "../collector/providers/grok.mjs";

test("desktop overrides are allowlisted and scoped to a selected source", () => {
  const settings = {sources: {deepseek: {mode:"on", values:{DEEPSEEK_API_KEY:"sample", PATH:"ignored"}}, claude:{mode:"off"}}};
  assert.deepEqual(sourceConfiguration("deepseek",settings,{PATH:"original"}).env,{DEEPSEEK_API_KEY:"sample",PATH:"original"});
  assert.equal(sourceConfiguration("claude",settings,{}).mode,"off");
  assert.deepEqual(sourceConfiguration("grok",settings,{}).env,{});
  assert.notEqual(sourceConfiguration("deepseek",settings,{}).revision,sourceConfiguration("deepseek",{},{}).revision);
});

test("widget exposes quota fields only and honors disabled, missing and expired windows", () => {
  const now=Date.parse("2030-01-01T00:00:00Z");
  const provider={id:"demo",name:"Demo",updatedAt:new Date(now).toISOString(),state:"ready",account:"private",windows:[{id:"weekly",usedPercent:17.22,resetsAt:"2030-01-02T00:00:00Z"}]};
  const snapshot={providers:[provider,{...provider,id:"empty",windows:[]},{...provider,id:"expired",windows:[{id:"weekly",usedPercent:100,resetsAt:"2029-12-31T00:00:00Z"}]}]};
  assert.deepEqual(widgetSnapshot(snapshot,false,now),{enabled:false,pools:[]});
  assert.deepEqual(widgetSnapshot(snapshot,true,now).pools,[{id:"demo",name:"Demo",remaining:83,reset:"2030-01-02T00:00:00Z",dayOnly:false,stale:false,staleAt:"2030-01-01T00:10:00.000Z"}]);
});

test("widget follows the shared staleness rule for old readings and manual snapshots", () => {
  const now = Date.parse("2030-01-03T12:00:00");
  const hoursAgo = (hours) => new Date(now - hours * 3_600_000).toISOString();
  const weekly = { id: "weekly", usedPercent: 40, resetsAt: "2030-01-08T00:00:00Z" };
  const pool = (id, updatedAt, extra = {}) => ({ id, name: id, state: "ready", updatedAt, windows: [weekly], ...extra });
  const dayOnly = (resetDate) => [{ id: "weekly", usedPercent: 40, resetsAt: null, resetDate }];
  const { pools } = widgetSnapshot({ providers: [
    pool("codex", hoursAgo(0.1)),
    pool("grok", hoursAgo(0.5)),
    pool("claude", hoursAgo(0.5)),
    pool("claude-fable", hoursAgo(2)),
    pool("manual-open", hoursAgo(30), { sourceKind: "manual", windows: dayOnly("2030-01-03") }),
    pool("manual-ended", hoursAgo(30), { sourceKind: "manual", windows: dayOnly("2030-01-02") }),
  ] }, true, now);
  assert.deepEqual(Object.fromEntries(pools.map(({ id, stale }) => [id, stale])), {
    codex: false, claude: false, "manual-open": false, grok: true, "claude-fable": true,
  });
  const staleAt = Object.fromEntries(pools.map((pool) => [pool.id, pool.staleAt]));
  assert.equal(staleAt.claude, new Date(now + 15 * 60_000).toISOString());
  assert.equal(staleAt["manual-open"], new Date("2030-01-04T00:00:00").toISOString());
});

test("unified Grok keeps source readings but never absorbs the Cursor billing pool", () => {
  const base={state:"ready",sharedWeekStart:"2030-01-01T00:00:00Z",windows:[{id:"weekly",resetsAt:"2030-01-08T00:00:00Z"}]};
  const providers=[{...base,id:"grok"},{...base,id:"grok-bot",cursorAccount:"sample"},{...base,id:"cursor",cursorAccount:"sample"}];
  const grouped=groupGrokSharedUsage(providers,Date.parse("2030-01-05"));
  assert.deepEqual(grouped.map(p=>p.id),["grok","cursor"]);
  assert.deepEqual(grouped[0].readings.map(p=>p.id),["grok","grok-bot"]);
});

test("the private env file sets only allowlisted keys, and a removed line stops applying", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-hub-env-"));
  const file = join(dir, "env");
  const env = { USAGE_HUB_ENV_FILE: file, USAGE_HUB_GROK_BIN: "from-launch", PATH: "original" };
  await writeFile(file, 'USAGE_HUB_GROK_BIN="/opt/grok"\nUSAGE_HUB_CLAUDE_BIN=/opt/claude\nPATH=/tmp/evil\n');
  await loadPrivateEnvironment(env);
  assert.deepEqual(env, {
    USAGE_HUB_ENV_FILE: file, USAGE_HUB_GROK_BIN: "/opt/grok", USAGE_HUB_CLAUDE_BIN: "/opt/claude", PATH: "original",
  });
  await writeFile(file, "# both lines removed\n");
  await loadPrivateEnvironment(env);
  assert.deepEqual(env, { USAGE_HUB_ENV_FILE: file, USAGE_HUB_GROK_BIN: "from-launch", PATH: "original" });
});

test("cloud push never pairs a file setting with a launch setting on reload", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "usage-hub-push-"));
  const file = join(dir, "env");
  const env = {
    USAGE_HUB_ENV_FILE: file,
    USAGE_HUB_PUSH_URL: "https://launch.invalid",
    USAGE_HUB_PUSH_TOKEN: "launch-fixture",
  };
  const warn = t.mock.method(console, "warn", () => {});
  const url = "USAGE_HUB_PUSH_URL=https://file.invalid\n";
  const token = "USAGE_HUB_PUSH_TOKEN=file-fixture\n";
  await writeFile(file, url + token);
  assert.deepEqual(await loadPrivateEnvironment(env), { url: "https://file.invalid", token: "file-fixture" });

  for (const line of [token, url]) {
    await writeFile(file, line);
    assert.equal(await loadPrivateEnvironment(env), null);
    assert.equal(await loadPrivateEnvironment(env), null);
    assert.equal(warn.mock.callCount(), 1);
  }
  assert.match(warn.mock.calls[0].arguments[0], /must come from the same source/);

  await writeFile(file, "");
  assert.deepEqual(await loadPrivateEnvironment(env), { url: "https://launch.invalid", token: "launch-fixture" });
});

test("the Claude status line writes its snapshot where the collector is configured to read it", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-hub-statusline-"));
  const snapshot = join(home, "nested", "claude-quota.json");
  const envFile = join(home, "env");
  await writeFile(envFile, `USAGE_HUB_CLAUDE_QUOTA_FILE="${snapshot}"\n`);
  const script = fileURLToPath(new URL("../collector/claude-statusline.mjs", import.meta.url));
  const reset = Math.floor(Date.now() / 1000) + 86_400;
  const run = promisify(execFile)(process.execPath, [script], {
    env: { HOME: home, PATH: process.env.PATH, USAGE_HUB_ENV_FILE: envFile },
  });
  run.child.stdin.end(JSON.stringify({
    model: { display_name: "ignored" },
    rate_limits: { seven_day: { used_percentage: 18, resets_at: reset }, five_hour: { used_percentage: 250, resets_at: reset } },
  }));
  const { stdout } = await run;
  assert.equal(stdout.trim(), "week 82% left");
  const saved = JSON.parse(await readFile(snapshot, "utf8"));
  assert.deepEqual(saved.rateLimits, { seven_day: { used_percentage: 18, resets_at: reset } });
  assert.ok(Date.now() - Date.parse(saved.capturedAt) < 60_000);
});
