/**
 * Pure argument-parsing helpers for the ai-usage-hub CLI.
 *
 * Kept free of side effects and of any imports beyond node:util so the
 * logic can be unit-tested without spawning processes.
 */
import { parseArgs } from "node:util";

export const MINIMUM_NODE_VERSION = "22.13.0";

export const CLI_COMMANDS = ["start", "collector", "menubar"];

/**
 * Compare two dotted numeric versions ("22.13.0"). Returns a negative
 * number, zero, or a positive number like a comparator.
 */
export function compareVersions(a, b) {
  const left = String(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function meetsNodeRequirement(actual, minimum = MINIMUM_NODE_VERSION) {
  return compareVersions(actual, minimum) >= 0;
}

/**
 * Parse CLI argv (already stripped of the node binary and script path).
 *
 * Returns `{ command, help, version, error }` where `error` is a message
 * string when the input is invalid, and `command` defaults to "start".
 */
export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return {
      command: null,
      help: false,
      version: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const { values, positionals } = parsed;
  const result = {
    command: "start",
    help: Boolean(values.help),
    version: Boolean(values.version),
    error: null,
  };
  if (positionals.length > 1) {
    result.command = null;
    result.error = `Unexpected extra argument: ${positionals[1]}`;
    return result;
  }
  if (positionals.length === 1) {
    if (!CLI_COMMANDS.includes(positionals[0])) {
      result.command = null;
      result.error = `Unknown command: ${positionals[0]}`;
      return result;
    }
    result.command = positionals[0];
  }
  return result;
}
