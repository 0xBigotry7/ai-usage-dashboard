import { desc, gte } from "drizzle-orm";
import { getDb } from "../../../db";
import { remoteUsageHistory } from "../../../db/schema";
import { isViewerAuthorized } from "../../../lib/remote-auth";

const HISTORY_LIMIT = 20_000;
// Raw rows arrive roughly every 5 minutes per provider/window; this bound
// comfortably covers 31 days of raw samples before downsampling.
const RAW_FETCH_LIMIT = 150_000;
const RAW_WINDOW_MS = 48 * 3_600_000;
const HOUR_MS = 3_600_000;

type HistoryRow = {
  providerId: string;
  windowId: string;
  usedPercent: number | null;
  capturedAt: string;
};

// Long windows would starve weekly reset estimation under a flat row limit:
// keep the newest 48 hours raw and aggregate anything older into hourly
// buckets (average usedPercent per provider/window/hour).
function downsample(chronological: HistoryRow[]): HistoryRow[] {
  const rawCutoffMs = Date.now() - RAW_WINDOW_MS;
  const recent: HistoryRow[] = [];
  const buckets = new Map<
    string,
    {
      providerId: string;
      windowId: string;
      hourMs: number;
      sum: number;
      count: number;
    }
  >();
  for (const row of chronological) {
    const capturedMs = Date.parse(row.capturedAt);
    if (capturedMs >= rawCutoffMs) {
      recent.push(row);
      continue;
    }
    if (row.usedPercent === null || !Number.isFinite(capturedMs)) continue;
    const hourMs = Math.floor(capturedMs / HOUR_MS) * HOUR_MS;
    const key = `${row.providerId}|${row.windowId}|${hourMs}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.sum += row.usedPercent;
      bucket.count += 1;
    } else {
      buckets.set(key, {
        providerId: row.providerId,
        windowId: row.windowId,
        hourMs,
        sum: row.usedPercent,
        count: 1,
      });
    }
  }
  const aggregated = [...buckets.values()]
    .sort((left, right) => left.hourMs - right.hourMs)
    .map((bucket) => ({
      providerId: bucket.providerId,
      windowId: bucket.windowId,
      usedPercent: bucket.sum / bucket.count,
      capturedAt: new Date(bucket.hourMs).toISOString(),
    }));
  return [...aggregated, ...recent];
}

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
    .limit(RAW_FETCH_LIMIT + 1);
  let truncated = rows.length > RAW_FETCH_LIMIT;
  const chronological = rows.slice(0, RAW_FETCH_LIMIT).reverse();

  let points = hours > 48 ? downsample(chronological) : chronological;
  if (points.length > HISTORY_LIMIT) {
    truncated = true;
    points = points.slice(points.length - HISTORY_LIMIT);
  }

  return Response.json(
    {
      generatedAt: new Date().toISOString(),
      truncated,
      points,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
