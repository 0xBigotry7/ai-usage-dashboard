/**
 * Shared shapes of the sanitized usage payload that flows from the collector
 * and cloud sync into the dashboard client.
 *
 * This module is types-only (no React, no runtime code) so it can be imported
 * from worker/API-route code and client components alike. The runtime
 * validator that produces these shapes from untrusted input lives in
 * lib/remote-usage.ts.
 */

export type WindowUsage = {
  id: string;
  label: string;
  durationSeconds: number | null;
  usedPercent: number | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null;
};

export type ModelTokenUsage = {
  id: string;
  label: string;
  windowId?: string;
  usedPercent?: number;
  capacityTokens?: number;
  estimatedTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  requestCount?: number;
  countedInTotal: boolean;
};

export type TokenUsage = {
  basis: "quota_percentage" | "session_logs" | "api_usage";
  periodId?: "today" | "weekly_cycle" | "rolling_7d" | "weekly_quota";
  scope?: "local_device" | "account" | "calibrated_quota";
  estimated: boolean;
  totalTokens: number;
  capacityTokens?: number;
  usedPercent?: number;
  windowId?: string;
  periodSeconds?: number;
  periodStartAt?: string | null;
  sessionCount?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  requestCount?: number;
  models: ModelTokenUsage[];
  assumption: string;
};

export type Provider = {
  id: string;
  name: string;
  shortName: string;
  accent: string;
  state: "ready" | "needs_configuration" | "auth_error" | "error";
  plan: string | null;
  source: string;
  sourceKind?: string;
  updatedAt: string;
  windows: WindowUsage[];
  balance: {
    label: string;
    value: number;
    unit: string;
  } | null;
  message: string | null;
  tokenUsage: TokenUsage | null;
  tokenEstimates?: TokenUsage[];
};

export type UsagePayload = {
  generatedAt: string;
  collector: {
    host?: string;
    version: string;
    state: "online" | "attention" | "starting";
    startedAt: string | null;
  };
  providers: Provider[];
};

export type HistoryPoint = {
  providerId: string;
  windowId: string;
  usedPercent: number | null;
  capturedAt: string;
};
