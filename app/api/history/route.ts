import { asc, gte } from "drizzle-orm";
import { getDb } from "../../../db";
import { remoteUsageHistory } from "../../../db/schema";
import { isViewerAuthorized } from "../../../lib/remote-auth";

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
  const points = await getDb()
    .select({
      providerId: remoteUsageHistory.providerId,
      windowId: remoteUsageHistory.windowId,
      usedPercent: remoteUsageHistory.usedPercent,
      capturedAt: remoteUsageHistory.capturedAt,
    })
    .from(remoteUsageHistory)
    .where(gte(remoteUsageHistory.capturedAt, since))
    .orderBy(asc(remoteUsageHistory.capturedAt))
    .limit(10_000);

  return Response.json(
    { generatedAt: new Date().toISOString(), points },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
