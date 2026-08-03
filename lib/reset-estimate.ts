import type { HistoryPoint } from "./usage-types";

type EstimateResetInput = {
  providerId: string;
  windowId: string;
  durationSeconds: number;
  history: HistoryPoint[];
  now?: number;
};

export function estimateNextResetAt({
  providerId,
  windowId,
  durationSeconds,
  history,
  now = Date.now(),
}: EstimateResetInput) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;

  const points = history
    .filter(
      (point) =>
        point.providerId === providerId &&
        point.windowId === windowId &&
        point.usedPercent !== null &&
        Number.isFinite(point.usedPercent) &&
        Number.isFinite(new Date(point.capturedAt).getTime()),
    )
    .sort(
      (left, right) =>
        new Date(left.capturedAt).getTime() -
        new Date(right.capturedAt).getTime(),
    );

  let resetAnchor: number | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      previous.usedPercent === null ||
      current.usedPercent === null ||
      previous.usedPercent - current.usedPercent < 1
    ) {
      continue;
    }

    const previousTime = new Date(previous.capturedAt).getTime();
    const currentTime = new Date(current.capturedAt).getTime();
    if (currentTime <= previousTime) continue;

    // The exact reset happened between the last pre-reset and first post-reset
    // sample. The midpoint gives a neutral estimate without claiming precision.
    resetAnchor = previousTime + (currentTime - previousTime) / 2;
  }

  if (resetAnchor === null) return null;

  const durationMilliseconds = durationSeconds * 1000;
  const cyclesElapsed = Math.max(
    0,
    Math.floor((now - resetAnchor) / durationMilliseconds) + 1,
  );
  return new Date(resetAnchor + cyclesElapsed * durationMilliseconds).toISOString();
}
