import {
  expiredViewerCookie,
  isViewerAuthorized,
  validateViewCode,
  viewerCookie,
} from "../../../lib/remote-auth";

export async function GET(request: Request) {
  return Response.json(
    { authenticated: await isViewerAuthorized(request) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  // A body of null, or a code that is not text, is a wrong code, not a crash.
  const submitted = (payload as { code?: unknown } | null)?.code;
  const code = typeof submitted === "string" ? submitted.trim() : "";
  if (!(await validateViewCode(code))) {
    return Response.json(
      { error: "invalid_view_code" },
      {
        status: 401,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
  return Response.json(
    { authenticated: true },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "Set-Cookie": await viewerCookie(),
      },
    },
  );
}

export async function DELETE() {
  return Response.json(
    { authenticated: false },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "Set-Cookie": expiredViewerCookie(),
      },
    },
  );
}
