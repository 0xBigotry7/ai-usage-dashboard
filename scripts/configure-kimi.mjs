/**
 * Source-checkout entry point for `npm run configure:kimi`.
 * The shared flow lives in bin/configure-lib.mjs so the published CLI
 * (`ai-usage-hub configure kimi`) runs exactly the same logic.
 */
import { runConfigureKimi } from "../bin/configure-lib.mjs";

process.exit(
  await runConfigureKimi({ commandHint: "npm run configure:kimi" }),
);
