import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_COMMANDS,
  MINIMUM_NODE_VERSION,
  compareVersions,
  meetsNodeRequirement,
  parseCliArgs,
} from "../bin/cli-args.mjs";

test("no arguments defaults to the start command", () => {
  assert.deepEqual(parseCliArgs([]), {
    command: "start",
    commandArgs: [],
    help: false,
    version: false,
    error: null,
  });
});

test("every documented command parses", () => {
  for (const command of CLI_COMMANDS) {
    const parsed = parseCliArgs([command]);
    assert.equal(parsed.command, command);
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.commandArgs, []);
  }
});

test("configure keeps its extra positionals as commandArgs", () => {
  const provider = parseCliArgs(["configure", "kimi"]);
  assert.equal(provider.command, "configure");
  assert.deepEqual(provider.commandArgs, ["kimi"]);
  assert.equal(provider.error, null);

  const capacity = parseCliArgs(["configure", "capacity", "codex", "15000000"]);
  assert.equal(capacity.command, "configure");
  assert.deepEqual(capacity.commandArgs, ["capacity", "codex", "15000000"]);
  assert.equal(capacity.error, null);

  const bare = parseCliArgs(["configure"]);
  assert.equal(bare.command, "configure");
  assert.deepEqual(bare.commandArgs, []);
  assert.equal(bare.error, null);
});

test("--help and -h are recognized, alone and with a command", () => {
  assert.equal(parseCliArgs(["--help"]).help, true);
  assert.equal(parseCliArgs(["-h"]).help, true);
  const withCommand = parseCliArgs(["menubar", "--help"]);
  assert.equal(withCommand.command, "menubar");
  assert.equal(withCommand.help, true);
});

test("--version and -v are recognized", () => {
  assert.equal(parseCliArgs(["--version"]).version, true);
  assert.equal(parseCliArgs(["-v"]).version, true);
});

test("an unknown command is an error, not a silent default", () => {
  const parsed = parseCliArgs(["dashboard"]);
  assert.equal(parsed.command, null);
  assert.match(parsed.error, /Unknown command: dashboard/);
});

test("an unknown flag is an error", () => {
  const parsed = parseCliArgs(["--port=1234"]);
  assert.equal(parsed.command, null);
  assert.match(parsed.error, /--port/);
});

test("extra positional arguments are an error outside configure", () => {
  const parsed = parseCliArgs(["start", "now"]);
  assert.equal(parsed.command, null);
  assert.match(parsed.error, /Unexpected extra argument: now/);
});

test("compareVersions orders dotted numeric versions", () => {
  assert.ok(compareVersions("22.13.0", "22.13.0") === 0);
  assert.ok(compareVersions("22.12.9", "22.13.0") < 0);
  assert.ok(compareVersions("23.0.0", "22.13.0") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.1") > 0);
  assert.ok(compareVersions("22.13", "22.13.1") < 0);
});

test("meetsNodeRequirement enforces the documented floor", () => {
  assert.equal(MINIMUM_NODE_VERSION, "22.13.0");
  assert.equal(meetsNodeRequirement("22.13.0"), true);
  assert.equal(meetsNodeRequirement("22.13.1"), true);
  assert.equal(meetsNodeRequirement("23.1.0"), true);
  assert.equal(meetsNodeRequirement("22.12.0"), false);
  assert.equal(meetsNodeRequirement("20.19.0"), false);
});
