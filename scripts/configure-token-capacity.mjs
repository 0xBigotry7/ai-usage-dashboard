/**
 * Source-checkout entry point for `npm run configure:capacity -- <provider> <n|clear>`.
 * The shared flow lives in bin/configure-lib.mjs so the published CLI
 * (`ai-usage-hub configure capacity <provider> <n|clear>`) runs exactly the
 * same logic.
 */
import { runConfigureCapacity } from "../bin/configure-lib.mjs";

process.exit(
  await runConfigureCapacity(process.argv[2], process.argv[3], {
    usageCommand:
      "npm run configure:capacity -- <codex|kimi> <weekly token capacity|clear>",
  }),
);
