import { useEffect } from "react";

/**
 * Global keyboard shortcuts for the dashboard: R refreshes, D switches
 * between the main and display views, and "," toggles the manage controls.
 * Ignored while typing or when a modifier key is held.
 */
export function useDashboardShortcuts({
  displayMode,
  onRefresh,
  onToggleControls,
}: {
  displayMode: boolean;
  onRefresh: () => void;
  onToggleControls: () => void;
}) {
  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isTyping || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "r") {
        onRefresh();
      }
      if (event.key.toLowerCase() === "d") {
        window.location.href = displayMode ? "/" : "/display";
      }
      if (event.key === ",") {
        onToggleControls();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [displayMode, onRefresh, onToggleControls]);
}
