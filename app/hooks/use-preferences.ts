import { useEffect, useState } from "react";

const PREFERENCE_KEY = "ai-usage-dashboard.preferences.v1";
export const WARNING_LEVELS = [60, 70, 80];

type DashboardPreferences = {
  warningThreshold: number;
  hiddenProviders: string[];
};

function savePreferences(next: DashboardPreferences) {
  window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(next));
}

/** Browser-local display preferences, persisted in localStorage. */
export function usePreferences() {
  const [warningThreshold, setWarningThreshold] = useState(70);
  const [hiddenProviders, setHiddenProviders] = useState<string[]>([]);

  useEffect(() => {
    // Defer the localStorage read past hydration so the server-rendered
    // defaults never disagree with the first client render.
    const initialTimer = window.setTimeout(() => {
      try {
        const preferences = JSON.parse(
          window.localStorage.getItem(PREFERENCE_KEY) || "{}",
        ) as Partial<DashboardPreferences>;
        if (WARNING_LEVELS.includes(Number(preferences.warningThreshold))) {
          setWarningThreshold(Number(preferences.warningThreshold));
        }
        if (Array.isArray(preferences.hiddenProviders)) {
          setHiddenProviders(
            preferences.hiddenProviders.filter(
              (value): value is string => typeof value === "string",
            ),
          );
        }
      } catch {
        // Invalid local preferences should not block live usage data.
      }
    }, 0);
    return () => window.clearTimeout(initialTimer);
  }, []);

  function chooseWarningThreshold(value: number) {
    setWarningThreshold(value);
    savePreferences({ warningThreshold: value, hiddenProviders });
  }

  function toggleProvider(providerId: string) {
    const next = hiddenProviders.includes(providerId)
      ? hiddenProviders.filter((id) => id !== providerId)
      : [...hiddenProviders, providerId];
    setHiddenProviders(next);
    savePreferences({ warningThreshold, hiddenProviders: next });
  }

  return {
    warningThreshold,
    hiddenProviders,
    chooseWarningThreshold,
    toggleProvider,
  };
}
