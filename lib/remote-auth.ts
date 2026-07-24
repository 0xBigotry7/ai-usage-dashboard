const SESSION_COOKIE = "ai_usage_dashboard_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type RuntimeSecrets = {
  INGEST_TOKEN?: string;
  VIEW_TOKEN?: string;
};

function runtimeSecrets() {
  return process.env as RuntimeSecrets;
}

function parseCookie(header: string | null, name: string) {
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key !== name) continue;
    return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return null;
}

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function secureEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([
    digest(`ai-usage-dashboard:${left}`),
    digest(`ai-usage-dashboard:${right}`),
  ]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

async function sessionValue(viewToken: string) {
  const hash = await digest(`ai-usage-dashboard-session:${viewToken}`);
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function isViewerAuthorized(request: Request) {
  const viewToken = runtimeSecrets().VIEW_TOKEN;
  if (!viewToken) return false;
  const cookie = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!cookie) return false;
  return secureEqual(cookie, await sessionValue(viewToken));
}

export async function validateViewCode(code: string) {
  const viewToken = runtimeSecrets().VIEW_TOKEN;
  if (!viewToken || !code) return false;
  return secureEqual(code, viewToken);
}

export async function isIngestAuthorized(request: Request) {
  const ingestToken = runtimeSecrets().INGEST_TOKEN;
  if (!ingestToken) return false;
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!token) return false;
  return secureEqual(token, ingestToken);
}

export async function viewerCookie() {
  const viewToken = runtimeSecrets().VIEW_TOKEN;
  if (!viewToken) throw new Error("VIEW_TOKEN is not configured");
  const value = await sessionValue(viewToken);
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function expiredViewerCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
