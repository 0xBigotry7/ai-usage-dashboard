function configuredCapacity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function estimateModel(window, { id, label, capacityTokens, countedInTotal }) {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  const normalizedCapacity = configuredCapacity(capacityTokens);
  // The platform's usedPercent is denominated in an internal billing unit,
  // not tokens, so multiplying it by any built-in constant yields numbers
  // that are orders of magnitude off. Only convert when the user has
  // calibrated a capacity via USAGE_HUB_*_WEEKLY_TOKEN_CAPACITY.
  if (normalizedCapacity === null) return null;
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
    periodId: "weekly_quota",
    scope: "calibrated_quota",
    estimated: true,
    totalTokens: primary.estimatedTokens,
    capacityTokens: primary.capacityTokens,
    usedPercent: primary.usedPercent,
    windowId: primary.windowId,
    models,
    assumption:
      "按周配额已用百分比乘以用户校准的订阅容量估算；该容量是用户校准值，不是平台官方 token 上限；独立模型额度不重复计入总量。",
  };
}

export function quotaCapacity(value, fallback) {
  return configuredCapacity(value) ?? fallback;
}
