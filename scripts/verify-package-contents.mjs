/**
 * prepack guard: refuse to pack/publish a tarball that is missing the
 * prebuilt artifacts the published CLI depends on.
 *
 * Escape hatch for local experiments on machines that cannot produce the
 * menu bar zip: USAGE_HUB_ALLOW_INCOMPLETE_PACK=1 npm pack
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const required = [
  ["dist/server/index.js", "npm run build"],
  ["dist/client", "npm run build"],
  ["prebuilt/menubar.zip", "npm run prebuilt:menubar (macOS + Xcode)"],
];

const missing = required.filter(([relative]) => !existsSync(join(root, relative)));

if (missing.length > 0 && process.env.USAGE_HUB_ALLOW_INCOMPLETE_PACK !== "1") {
  console.error("Refusing to pack an incomplete package. Missing:");
  for (const [relative, remedy] of missing) {
    console.error(`  - ${relative}  (produce it with: ${remedy})`);
  }
  console.error(
    "Set USAGE_HUB_ALLOW_INCOMPLETE_PACK=1 to bypass for local experiments.",
  );
  process.exit(1);
}

if (missing.length > 0) {
  console.warn(
    `Packing with ${missing.length} missing prebuilt artifact(s) because ` +
      "USAGE_HUB_ALLOW_INCOMPLETE_PACK=1 is set.",
  );
}
