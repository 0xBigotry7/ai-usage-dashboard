/**
 * Source-checkout entry point for `npm run configure:provider -- <provider>`.
 * The shared flow lives in bin/configure-lib.mjs so the published CLI
 * (`ai-usage-hub configure <provider>`) runs exactly the same logic.
 */
import { runConfigureProvider } from "../bin/configure-lib.mjs";

process.exit(
  await runConfigureProvider(process.argv[2], {
    exampleCommand: "npm run configure:provider -- openrouter",
  }),
);
