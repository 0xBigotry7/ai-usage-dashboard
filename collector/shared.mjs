import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

export const HUB_VERSION = pkg.version;

export function resolvePollIntervalMs(
  raw,
  { fallbackMs = 60_000, minimumMs = 30_000 } = {},
) {
  const trimmed = String(raw ?? "").trim();
  const parsed = trimmed === "" ? fallbackMs : Number(trimmed);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `Invalid USAGE_HUB_POLL_INTERVAL_MS value "${raw}"; falling back to ${fallbackMs}ms.`,
    );
    return Math.max(minimumMs, fallbackMs);
  }
  return Math.max(minimumMs, parsed);
}

export function parseEnvAssignment(rawLine) {
  const line = String(rawLine ?? "").trim();
  if (!line || line.startsWith("#")) return null;
  const assignment = line.startsWith("export ")
    ? line.slice("export ".length).trim()
    : line;
  const separator = assignment.indexOf("=");
  if (separator <= 0) return null;
  const key = assignment.slice(0, separator).trim();
  let value = assignment.slice(separator + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

export function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toIsoTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function durationToWindow(durationSeconds) {
  if (durationSeconds === 18_000) {
    return { id: "five_hour", label: "5-hour", durationSeconds };
  }
  if (durationSeconds === 604_800) {
    return { id: "weekly", label: "Weekly", durationSeconds };
  }
  if (durationSeconds === 86_400) {
    return { id: "daily", label: "Daily", durationSeconds };
  }
  const hours = Math.round((durationSeconds / 3600) * 10) / 10;
  return {
    id: `window_${durationSeconds}`,
    label: hours >= 24 ? `${Math.round(hours / 24)}-day` : `${hours}-hour`,
    durationSeconds,
  };
}

export function usagePercent({ used, limit, remaining }) {
  const usedNumber = numberOrNull(used);
  const limitNumber = numberOrNull(limit);
  const remainingNumber = numberOrNull(remaining);

  if (usedNumber !== null && limitNumber !== null && limitNumber > 0) {
    return clampPercent((usedNumber / limitNumber) * 100);
  }
  if (remainingNumber !== null && limitNumber !== null && limitNumber > 0) {
    return clampPercent(((limitNumber - remainingNumber) / limitNumber) * 100);
  }
  return null;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function resolveHomePath(path) {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function detailedNetworkError(error) {
  const code = error?.cause?.code || error?.code;
  if (!code) return null;
  const normalized = String(code).toUpperCase();
  let label = "Network connection failed";
  if (normalized === "ECONNRESET") label = "Connection reset";
  else if (normalized === "ECONNREFUSED") label = "Connection refused";
  else if (normalized === "ENOTFOUND" || normalized === "EAI_AGAIN") {
    label = "DNS lookup failed";
  } else if (normalized.includes("TIMEOUT") || normalized === "ETIMEDOUT") {
    label = "Connection timed out";
  }
  const detailed = new Error(`${label} (${normalized})`, { cause: error });
  detailed.code = normalized;
  return detailed;
}

export async function fetchJson(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    if (payload === null) {
      throw new Error("Service returned data that could not be parsed");
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Connection timed out");
    }
    const detailed = detailedNetworkError(error);
    if (detailed) throw detailed;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function providerError(provider, error, source, updatedAt = new Date().toISOString()) {
  const status = error?.status;
  const authError = status === 401 || status === 403;
  const retryable =
    !authError &&
    (!status || status === 408 || status === 429 || status >= 500);
  return {
    id: provider.id,
    name: provider.name,
    shortName: provider.shortName,
    accent: provider.accent,
    state: authError ? "auth_error" : "error",
    plan: null,
    source,
    updatedAt,
    windows: [],
    balance: null,
    message: authError
      ? provider.authMessage
      : error?.message || "Temporarily unable to fetch quota data",
    retryable,
  };
}
