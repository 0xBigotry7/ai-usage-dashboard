import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const HUB_VERSION = "0.5.0";

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
    return { id: "five_hour", label: "5 小时", durationSeconds };
  }
  if (durationSeconds === 604_800) {
    return { id: "weekly", label: "本周", durationSeconds };
  }
  if (durationSeconds === 86_400) {
    return { id: "daily", label: "今日", durationSeconds };
  }
  const hours = Math.round((durationSeconds / 3600) * 10) / 10;
  return {
    id: `window_${durationSeconds}`,
    label: hours >= 24 ? `${Math.round(hours / 24)} 天` : `${hours} 小时`,
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
    if (payload === null) throw new Error("服务返回了无法解析的数据");
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("连接超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function providerError(provider, error, source, updatedAt = new Date().toISOString()) {
  const status = error?.status;
  const authError = status === 401 || status === 403;
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
      : error?.message || "暂时无法取得配额数据",
  };
}
