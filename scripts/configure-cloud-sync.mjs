import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const pushUrl = process.argv[2]?.trim();
const directory = join(homedir(), ".usage-hub");
const secretsPath = join(directory, "cloud-secrets.json");
const envPath = join(directory, "env");
const viewCodePath = join(directory, "view-code");
await mkdir(directory, { recursive: true, mode: 0o700 });

let generatedSecrets = {};
try {
  generatedSecrets = JSON.parse(await readFile(secretsPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

let existing = "";
let existingViewToken = "";
try {
  existing = await readFile(envPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
try {
  existingViewToken = (await readFile(viewCodePath, "utf8")).trim();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const values = new Map();
for (const rawLine of existing.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator <= 0) continue;
  values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
}

const pushToken =
  process.env.USAGE_HUB_PUSH_TOKEN?.trim() ||
  generatedSecrets.INGEST_TOKEN ||
  generatedSecrets.ingestToken ||
  values.get("USAGE_HUB_PUSH_TOKEN");
const viewToken =
  process.env.USAGE_HUB_VIEW_TOKEN?.trim() ||
  generatedSecrets.VIEW_TOKEN ||
  generatedSecrets.viewToken ||
  existingViewToken;

if (!pushUrl || !pushToken || !viewToken) {
  console.error(
    "Usage: npm run configure:cloud -- https://your-dashboard.example/api/ingest\n" +
      "Run npm run generate:cloud-secrets first, or set " +
      "USAGE_HUB_PUSH_TOKEN and USAGE_HUB_VIEW_TOKEN.",
  );
  process.exit(1);
}

const endpoint = new URL(pushUrl);
if (
  endpoint.protocol !== "https:" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== "/api/ingest" ||
  endpoint.search ||
  endpoint.hash
) {
  console.error(
    "Cloud sync URL must be a credential-free HTTPS /api/ingest endpoint.",
  );
  process.exit(1);
}

values.set("USAGE_HUB_PUSH_URL", pushUrl);
values.set("USAGE_HUB_PUSH_TOKEN", pushToken);
values.set("USAGE_HUB_CLOUD_URL", `${endpoint.origin}/`);

const serialized = `${Array.from(values, ([key, value]) => `${key}=${value}`).join("\n")}\n`;
await writeFile(envPath, serialized, { encoding: "utf8", mode: 0o600 });
await writeFile(viewCodePath, `${viewToken}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
await Promise.all([chmod(envPath, 0o600), chmod(viewCodePath, 0o600)]);
console.log("Cloud sync secrets saved to the local private configuration.");
