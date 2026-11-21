import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Renders only this app's synthetic demo view, never the desktop or live data.
if (process.platform !== "darwin") throw new Error("Preview rendering requires macOS");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "docs/images/menu-bar-overview.png");
mkdirSync(dirname(output), { recursive: true });
execFileSync("swift", ["build", "-c", "release", "--package-path", "apps/macos-menu-bar"], {
  cwd: root, stdio: "inherit",
});
const bin = execFileSync("swift", ["build", "-c", "release", "--package-path", "apps/macos-menu-bar", "--show-bin-path"], {
  cwd: root, encoding: "utf8",
}).trim();
execFileSync(resolve(bin, "UsageMenuBar"), ["--demo", "--demo-export", output], {
  cwd: root, stdio: "inherit", timeout: 30_000,
});
if (!existsSync(output)) throw new Error("Demo preview export did not produce an image");
// Preserve pixels verbatim while excluding EXIF/text metadata from public assets.
const png = readFileSync(output);
if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
  throw new Error("Demo export is not a PNG");
}
const chunks = [png.subarray(0, 8)];
for (let offset = 8; offset < png.length;) {
  const length = png.readUInt32BE(offset);
  const end = offset + length + 12;
  if (end > png.length) throw new Error("Truncated demo PNG");
  const type = png.toString("ascii", offset + 4, offset + 8);
  if (!["eXIf", "tEXt", "iTXt", "zTXt", "tIME"].includes(type)) {
    chunks.push(png.subarray(offset, end));
  }
  offset = end;
}
writeFileSync(output, Buffer.concat(chunks));
console.log("Saved synthetic native preview: docs/images/menu-bar-overview.png");
