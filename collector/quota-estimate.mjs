const DEFAULT_WEEKLY_CAPACITY_TOKENS = 10_000_000;

function capacity(value, fallback = DEFAULT_WEEKLY_CAPACITY_TOKENS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function estimateModel(window, { id, label, capacityTokens, countedInTotal }) {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  const normalizedCapacity = capacity(capacityTokens);
  const usedPercent = Math.max(0, Math.min(100, Number(window.usedPercent)));
  return {
    id,
    label,
    windowId: window.id,
    usedPercent,
    capacityTokens: normalizedCapacity,
    estimatedTokens: Math.round((normalizedCapacity * usedPercent) / 100),
    countedInTotal,
  };
}

export function estimateWeeklyQuotaTokens(
  windows,
  {
    id,
    label,
    capacityTokens,
    scopedModels = [],
  },
) {
  const weekly = windows.find((window) => window.id === "weekly");
  const primary = estimateModel(weekly, {
    id,
    label,
    capacityTokens,
    countedInTotal: true,
  });
  if (!primary) return null;

  const models = [
    primary,
    ...scopedModels
      .map((model) =>
        estimateModel(
          windows.find((window) => window.id === model.windowId),
          {
            ...model,
            countedInTotal: false,
          },
        ),
      )
      .filter(Boolean),
  ];

  return {
    basis: "quota_percentage",
    estimated: true,
    totalTokens: primary.estimatedTokens,
    capacityTokens: primary.capacityTokens,
    usedPercent: primary.usedPercent,
    windowId: primary.windowId,
    models,
    assumption:
      "按周配额已用百分比乘以面板设定的订阅容量估算；独立模型额度不重复计入总量。",
  };
}

export function quotaCapacity(value, fallback) {
  return capacity(value, fallback);
}
