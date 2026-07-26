import { eq, lt } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  remoteSnapshots,
  remoteUsageHistory,
} from "../../../db/schema";
import { isIngestAuthorized } from "../../../lib/remote-auth";
import { sanitizeRemoteSnapshot } from "../../../lib/remote-usage";

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request) {
  if (!(await isIngestAuthorized(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  let snapshot;
  try {
    snapshot = sanitizeRemoteSnapshot(JSON.parse(rawBody));
  } catch (error) {
    return Response.json(
      {
        error: "invalid_snapshot",
        message: error instanceof Error ? error.message : "Invalid snapshot",
      },
      { status: 400 },
    );
  }

  const receivedAt = new Date().toISOString();
  const receivedAtMs = Date.parse(receivedAt);
  // A pusher's self-reported clock must not write history in the future.
  const clampToReceivedAt = (value: string) =>
    Date.parse(value) > receivedAtMs ? receivedAt : value;
  const snapshotGeneratedAt = clampToReceivedAt(snapshot.generatedAt);
  const db = getDb();

  for (const provider of snapshot.providers) {
    const providerCapturedAt = clampToReceivedAt(
      provider.updatedAt || snapshotGeneratedAt,
    );
    let storedProvider = {
      ...provider,
      updatedAt: providerCapturedAt,
    };
    const isTransientRateLimit =
      provider.state === "error" &&
      /(?:HTTP\s*)?429|rate.?limit|限流/i.test(provider.message || "");
    if (isTransientRateLimit) {
      const [existing] = await db
        .select()
        .from(remoteSnapshots)
        .where(eq(remoteSnapshots.id, provider.id))
        .limit(1);
      if (existing) {
        try {
          const previous = sanitizeRemoteSnapshot({
            generatedAt: existing.generatedAt,
            providers: [JSON.parse(existing.payload)],
          }).providers[0];
          if (previous?.state === "ready") {
            storedProvider = {
              ...previous,
              source: `${previous.source} · 上次成功快照`,
              message:
                provider.message ||
                "提供方用量接口暂时限流，显示上次成功数据。",
            };
          }
        } catch {
          // Ignore malformed legacy rows and store the new sanitized provider.
        }
      }
    }

    await db
      .insert(remoteSnapshots)
      .values({
        id: storedProvider.id,
        payload: JSON.stringify(storedProvider),
        generatedAt: storedProvider.updatedAt || snapshot.generatedAt,
        receivedAt,
      })
      .onConflictDoUpdate({
        target: remoteSnapshots.id,
        set: {
          payload: JSON.stringify(storedProvider),
          generatedAt: storedProvider.updatedAt || snapshot.generatedAt,
          receivedAt,
        },
      });

    if (provider.state !== "ready") continue;
    for (const window of provider.windows) {
      await db
        .insert(remoteUsageHistory)
        .values({
          providerId: provider.id,
          windowId: window.id,
          usedPercent: window.usedPercent,
          capturedAt: providerCapturedAt,
          captureBucket: Math.floor(
            Date.parse(providerCapturedAt) / 300_000,
          ),
        })
        .onConflictDoNothing();
    }
  }

  // Bound history growth: drop rows older than 31 days on every ingest.
  const historyCutoff = new Date(
    Date.now() - 31 * 24 * 3_600_000,
  ).toISOString();
  await db
    .delete(remoteUsageHistory)
    .where(lt(remoteUsageHistory.capturedAt, historyCutoff));

  return Response.json(
    {
      ok: true,
      receivedAt,
      providers: snapshot.providers.map((provider) => provider.id),
    },
    { status: 202 },
  );
}
