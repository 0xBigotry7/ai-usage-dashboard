import { hostname } from "node:os";
import {
  clampPercent,
  fetchJson,
  HUB_VERSION,
  numberOrNull,
  providerError,
  toIsoTime,
} from "../shared.mjs";

const OPENCODE_GO = {
  id: "opencode-go",
  name: "OpenCode Go",
  shortName: "OC",
  accent: "#9be7c4",
  authMessage:
    "OpenCode Go key was rejected by the usage endpoint. Check OPENCODE_GO_API_KEY, or create a new key in the OpenCode console.",
};

// Documented at https://opencode.ai/docs/go/ ("Usage endpoint"). The older
// /zen/ path is what the Console Go page used before the docs were written;
// it is tried only when the documented path is missing (404).
const USAGE_URLS = [
  "https://opencode.ai/inference/go/v1/usage",
  "https://opencode.ai/zen/go/v1/usage",
];

// All paid Go models share one allowance, so these three meters cover
// DeepSeek, GLM, Kimi and the rest together. The 5-hour window starts at
// first use; weekly resets Monday 00:00 UTC; monthly follows the billing
// period, so its duration is approximate.
const METERS = [
  { key: "rolling", id: "five_hour", label: "5-hour", durationSeconds: 18_000 },
  { key: "weekly", id: "weekly", label: "Weekly", durationSeconds: 604_800 },
  { key: "monthly", id: "monthly", label: "Monthly", durationSeconds: 2_592_000 },
];

export function normalizeOpenCodeGoUsage(
  payload,
  updatedAt = new Date().toISOString(),
) {
  const usage = payload?.usage ?? payload ?? {};
  const windows = [];
  const limited = [];
  for (const meter of METERS) {
    const entry = usage?.[meter.key];
    const usedPercent = clampPercent(numberOrNull(entry?.percent));
    if (usedPercent === null) continue;
    const status = typeof entry?.status === "string" ? entry.status : null;
    if (status && status !== "ok") limited.push(meter.label);
    windows.push({
      id: meter.id,
      label: meter.label,
      durationSeconds: meter.durationSeconds,
      usedPercent,
      used: null,
      limit: null,
      remaining: null,
      resetsAt: toIsoTime(entry?.resetsAt),
    });
  }

  return {
    id: OPENCODE_GO.id,
    name: OPENCODE_GO.name,
    shortName: OPENCODE_GO.shortName,
    accent: OPENCODE_GO.accent,
    state: "ready",
    plan: "Go",
    source: "OpenCode Go usage endpoint",
    sourceKind: "api_key",
    host: hostname(),
    updatedAt,
    windows,
    balance: null,
    message:
      windows.length === 0
        ? "OpenCode Go returned no usage meters."
        : limited.length > 0
          ? `Limit reached: ${limited.join(", ")}. One shared allowance covers every paid Go model.`
          : "One shared allowance covers every paid Go model (DeepSeek, GLM, Kimi and others).",
    tokenUsage: null,
    tokenEstimates: [],
  };
}

export async function collectOpenCodeGoUsage(env = process.env) {
  const updatedAt = new Date().toISOString();
  const apiKey = env.OPENCODE_GO_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error("Missing OPENCODE_GO_API_KEY");
    error.status = 401;
    const result = providerError(
      OPENCODE_GO,
      error,
      "Waiting for OpenCode Go key",
      updatedAt,
    );
    result.state = "needs_configuration";
    result.message =
      "Add your OpenCode Go key with: npm run configure:provider -- opencode-go";
    result.tokenUsage = null;
    return result;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": `AI-Usage-Dashboard/${HUB_VERSION}`,
  };
  let lastError = null;
  for (const url of USAGE_URLS) {
    try {
      const payload = await fetchJson(url, { headers });
      return normalizeOpenCodeGoUsage(payload, updatedAt);
    } catch (error) {
      lastError = error;
      if (error?.status !== 404) break;
    }
  }
  return providerError(
    OPENCODE_GO,
    lastError,
    "OpenCode Go usage endpoint",
    updatedAt,
  );
}
