import { spawn } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { clampPercent, HUB_VERSION, providerError, toIsoTime } from "../shared.mjs";

const GROK = {
  id: "grok",
  name: "Grok",
  shortName: "GR",
  accent: "#d7d9e0",
};
const SOURCE = "Grok Build usage";

// The local ACP billing extension is the same read-only request used by the
// official /usage panel. Grok manages login and sends the upstream request.
function getBilling(binary) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["agent", "stdio"], {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      finish(new Error("Grok Build usage request timed out."));
    }, 12_000);
    let settled = false;

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.stdin.destroy();
      child.kill();
      if (error) reject(error);
      else resolve(result);
    }

    function send(id, method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    }

    child.on("error", finish);
    child.stdin.on("error", () => finish(new Error("Grok Build stopped before returning usage.")));
    child.on("close", () => finish(new Error("Grok Build exited before returning usage.")));
    lines.on("line", (line) => {
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      if (reply?.id !== 1 && reply?.id !== 2) return;
      if (reply.error || !reply.result) {
        finish(new Error("Grok Build could not return subscription usage."));
      } else if (reply.id === 1) {
        send(2, "_x.ai/billing", {});
      } else {
        finish(null, reply.result);
      }
    });
    send(1, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "ai-usage-dashboard", version: HUB_VERSION },
    });
  });
}

export function normalizeGrokBilling(payload, updatedAt = new Date().toISOString()) {
  const config = payload?.config;
  const period = config?.currentPeriod;
  const usedPercent = clampPercent(config?.creditUsagePercent);
  const resetsAt = toIsoTime(period?.end);
  const monthly = period?.type === "USAGE_PERIOD_TYPE_MONTHLY";
  const weekly = period?.type === "USAGE_PERIOD_TYPE_WEEKLY";
  if (usedPercent === null || !resetsAt || (!weekly && !monthly)) {
    throw new Error("Grok Build did not report a subscription allowance and reset time.");
  }

  const seconds = (Date.parse(resetsAt) - Date.parse(period.start)) / 1_000;
  const durationSeconds = Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds)
    : weekly ? 604_800 : null;
  const prepaidCents = config.prepaidBalance?.val;
  return {
    ...GROK,
    state: "ready",
    plan: typeof payload.subscription_tier === "string"
      ? payload.subscription_tier.slice(0, 80)
      : null,
    source: SOURCE,
    sourceKind: "cli",
    host: hostname(),
    updatedAt,
    sharedWeekStart: weekly && config.isUnifiedBillingUser === true ? toIsoTime(period.start) : null,
    windows: [{
      id: weekly ? "weekly" : "monthly",
      label: weekly ? "Weekly" : "Monthly",
      durationSeconds,
      usedPercent,
      used: null,
      limit: null,
      remaining: null,
      resetsAt,
    }],
    balance: Number.isFinite(prepaidCents) && prepaidCents !== 0
      ? { label: "Prepaid credits", value: Math.abs(prepaidCents) / 100, unit: "USD" }
      : null,
    message: config.isUnifiedBillingUser === true
      ? "Shared account allowance reported by Grok Build."
      : "Subscription allowance reported by Grok Build.",
    tokenUsage: null,
    tokenEstimates: [],
  };
}

export function groupGrokSharedUsage(providers, now = Date.now()) {
  const build = providers.find(({ id }) => id === "grok");
  const bot = providers.find(({ id }) => id === "grok-bot");
  const buildWeek = build?.windows.find(({ id }) => id === "weekly");
  const botWeek = bot?.windows.find(({ id }) => id === "weekly");

  if (build?.state !== "ready" || bot?.state !== "ready" ||
      !build.sharedWeekStart || build.sharedWeekStart !== bot.sharedWeekStart ||
      !buildWeek?.resetsAt || buildWeek.resetsAt !== botWeek?.resetsAt ||
      Date.parse(buildWeek.resetsAt) <= now) {
    return providers;
  }

  const readings = [
    [build, "Grok Build", "Shared account meter"],
    [bot, "Grok Bot", "Bot-reported weekly meter"],
  ].filter(([provider]) => provider).map(([provider, name, scope]) => ({
    id: provider.id,
    name,
    scope,
    updatedAt: provider.updatedAt,
    windows: provider.windows,
    details: provider.usageDetails ?? [],
    message: provider.state === "ready" && !provider.message?.includes("Stale data") ? null : provider.message,
  }));

  const shared = {
    ...build,
    name: "Grok Shared Usage",
    windows: [{ ...buildWeek, label: "Weekly shared allowance" }],
    readings,
  };
  return providers.flatMap((provider) => {
    if (provider === build) return [shared];
    return provider === bot ? [] : [provider];
  });
}

export async function collectGrokUsage(env = process.env) {
  const updatedAt = new Date().toISOString();
  const binary = env.USAGE_HUB_GROK_BIN?.trim();
  if (!binary) {
    return {
      ...providerError(GROK, new Error("Grok Build is not configured."), SOURCE, updatedAt),
      state: "needs_configuration",
      retryable: false,
    };
  }
  try {
    return normalizeGrokBilling(await getBilling(binary), updatedAt);
  } catch (error) {
    return providerError(GROK, error, SOURCE, updatedAt);
  }
}
