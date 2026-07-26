import { desc, gte } from "drizzle-orm";
import { getDb } from "../../../db";
import { remoteUsageHistory } from "../../../db/schema";
import { isViewerAuthorized } from "../../../lib/remote-auth";

const HISTORY_LIMIT = 10_000;

export async function GET(request: Request) {
  if (!(await isViewerAuthorized(request))) {
    return Response.json(
      { error: "authentication_required" },
      {
        status: 401,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }

  const url = new URL(request.url);
  const hours = Math.max(
    1,
    Math.min(24 * 31, Number(url.searchParams.get("hours")) || 24),
  );
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  // Take the newest rows first so a limit hit drops the oldest samples
  // instead of freezing the trend days in the past, then restore
  // chronological order for the response.
  const rows = await getDb()
    .select({
      providerId: remoteUsageHistory.providerId,
      windowId: remoteUsageHistory.windowId,
      usedPercent: remoteUsageHistory.usedPercent,
      capturedAt: remoteUsageHistory.capturedAt,
    })
    .from(remoteUsageHistory)
    .where(gte(remoteUsageHistory.capturedAt, since))
    .orderBy(desc(remoteUsageHistory.capturedAt))
    .limit(HISTORY_LIMIT + 1);
  const truncated = rows.length > HISTORY_LIMIT;
  const points = rows.slice(0, HISTORY_LIMIT).reverse();

  return Response.json(
    {
      generatedAt: new Date().toISOString(),
      truncated,
      points,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
