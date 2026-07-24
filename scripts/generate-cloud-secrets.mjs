import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const directory = join(homedir(), ".usage-hub");
const path = join(directory, "cloud-secrets.json");
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(
  path,
  `${JSON.stringify({
    INGEST_TOKEN: randomBytes(32).toString("hex"),
    VIEW_TOKEN: randomBytes(18).toString("base64url"),
  })}\n`,
  { encoding: "utf8", mode: 0o600 },
);
await chmod(path, 0o600);
console.log(`Cloud deployment secrets generated at ${path}.`);
