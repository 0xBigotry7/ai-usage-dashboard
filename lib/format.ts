/** Pure display formatters shared by the dashboard client components. */

export function clamp(value: number) {
  return Math.max(0, Math.min(100, value));
}

export function formatPercent(value: number | null) {
  return value === null ? "—" : `${Math.round(value)}%`;
}

export function formatNumber(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value % 1 ? 1 : 0,
  }).format(value);
}

export function formatTokens(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(value);
}

export function exactTokens(value: number) {
  return `${new Intl.NumberFormat(undefined).format(value)} tokens`;
}

export function formatBalance(value: number, unit: string) {
  const normalizedUnit = unit.toUpperCase();
  const prefix =
    normalizedUnit === "USD" ? "$" : normalizedUnit === "CNY" ? "¥" : "";
  const suffix =
    prefix || !normalizedUnit || normalizedUnit === "CREDITS"
      ? ""
      : ` ${normalizedUnit}`;
  return `${prefix}${formatNumber(value)}${suffix}`;
}

export function formatCountdown(resetsAt: string | null) {
  if (!resetsAt) return "no reset time provided";
  const difference = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(difference)) return "reset time unknown";
  if (difference <= 0) return "awaiting refresh";
  const minutes = Math.max(1, Math.floor(difference / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const restMinutes = minutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${restMinutes}m`;
  return `in ${restMinutes}m`;
}

export function formatResetClock(resetsAt: string | null) {
  if (!resetsAt) return "time unknown";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(resetsAt));
}

export function formatShortDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
}

export function formatUpdated(value: string | null) {
  if (!value) return "not connected yet";
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function formatAge(value: string | null) {
  if (!value) return "time unknown";
  const ageMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ageMs)) return "unknown";
  if (ageMs < 0) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
