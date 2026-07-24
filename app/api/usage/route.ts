import { getDb } from "../../../db";
import { remoteSnapshots } from "../../../db/schema";
import { isViewerAuthorized } from "../../../lib/remote-auth";
import { mergeRemoteProviderRows } from "../../../lib/remote-usage";

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

  const rows = await getDb().select().from(remoteSnapshots);
  const snapshot = mergeRemoteProviderRows(rows);
  if (!snapshot) {
    return Response.json(
      { error: "waiting_for_first_snapshot" },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }

  return new Response(JSON.stringify(snapshot), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}
