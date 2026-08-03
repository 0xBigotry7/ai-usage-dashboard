/**
 * Serve the prebuilt web dashboard from this package's dist/ directory.
 *
 * Uses vinext's production server directly (the same engine as
 * `vinext start`) with an explicit outDir, so it works from any working
 * directory — including a global npm install. Binds to 127.0.0.1 by
 * default; the dashboard is a local-first tool.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProdServer } from "vinext/server/prod-server";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

await startProdServer({
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "127.0.0.1",
  outDir: path.join(packageRoot, "dist"),
});
