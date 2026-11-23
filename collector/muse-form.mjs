import { MUSE_VALIDATION_ERROR, readMuseUsage, saveMuseUsage } from "./providers/muse.mjs";

const TOO_LARGE = "The update is too large.";

function localInputDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16);
}

async function museInput(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 4_096) throw new Error(TOO_LARGE);
  }
  const data = new URLSearchParams(body);
  const weeklyRemaining = data.get("weeklyRemaining")?.trim();
  const bonusTokens = data.get("bonusTokens")?.trim();
  const resetDate = data.get("resetDate")?.trim();
  const resetTime = data.get("resetTime")?.trim();
  if (resetTime && !/^\d{2}:\d{2}$/.test(resetTime)) throw new Error(MUSE_VALIDATION_ERROR);
  return {
    weeklyRemaining: weeklyRemaining ? Number(weeklyRemaining) : NaN,
    bonusTokens: bonusTokens ? Number(bonusTokens) : NaN,
    resetDate,
    resetsAt: resetTime && resetDate ? `${resetDate}T${resetTime}` : null,
    bonusApproximate: data.has("bonusApproximate"),
  };
}

export async function serveMuseForm(request, response, path, saved, refresh) {
  let error = "";
  let status = 200;
  if (request.method === "POST") {
    try {
      await saveMuseUsage(path, await museInput(request));
    } catch (failure) {
      const validation = failure?.message === MUSE_VALIDATION_ERROR || failure?.message === TOO_LARGE;
      status = validation ? 400 : 500;
      error = validation ? failure.message : "Could not save the snapshot. Check the collector and try again.";
    }
    if (!error) {
      await refresh().catch(() => {}); // The snapshot stays saved if collection is delayed.
      response.writeHead(303, { Location: "/muse?saved=1", "Cache-Control": "no-store" });
      response.end();
      return;
    }
  }

  const current = await readMuseUsage(path);
  // Only these fixed messages and the validated values from disk are rendered.
  const notice = error || (saved ? "Saved. The dashboard will display this snapshot." : "");
  const localReset = localInputDate(current?.resetsAt);
  const updated = current
    ? `Last updated ${new Date(current.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`
    : "No snapshot saved";
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin",
  });
  response.end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Update Muse usage</title>
<style>
  :root{color-scheme:dark;background:#161b22;color:#f0f2f6;font:16px system-ui}
  body{margin:0;padding:24px}main{max-width:490px;margin:30px auto;padding:28px;border-radius:18px;background:#212935}
  h1{font-size:25px;margin:0 0 8px}p{color:#b4bfcc;line-height:1.5}
  label{display:grid;gap:6px;margin:18px 0}input,button{font:inherit;border-radius:8px;padding:10px 12px}
  input{box-sizing:border-box;width:100%;border:1px solid #66758a;background:#161b22;color:inherit}
  label.check{display:flex;align-items:center}input[type=checkbox]{width:auto}
  button{border:0;background:#abc2ff;color:#142142;font-weight:650;cursor:pointer}
  a{color:#abc2ff}.actions{display:flex;align-items:center;gap:18px}.notice{color:#e5ca91}
</style>
<main><h1>Update Muse usage</h1>
<p>Copy the figures from the <a href="hatch://">installed Muse app</a> under Settings → Usage.</p>
${notice ? `<p class="notice" role="${error ? "alert" : "status"}">${notice}</p>` : ""}
<form method="post" action="/muse">
<label>Free weekly remaining (%)<input required name="weeklyRemaining" type="number" min="0" max="100" step="any" value="${current?.weeklyRemaining ?? ""}"></label>
<label>Weekly reset date<input required name="resetDate" type="date" value="${current?.resetDate ?? localReset.slice(0, 10)}"></label>
<label>Weekly reset time (${timezone}, if shown)<input name="resetTime" type="time" value="${localReset.slice(11)}"></label>
<label>Referral token balance<input required name="bonusTokens" type="number" min="0" max="9007199254740991" step="1" value="${current?.bonusTokens ?? ""}"></label>
<label class="check"><input type="checkbox" name="bonusApproximate" ${current?.bonusApproximate ? "checked" : ""}>Balance shown rounded by Muse</label>
<p>Enter 1000000000 for 1 billion tokens.</p>
<div class="actions"><button type="submit">Save snapshot</button><a href="http://localhost:3000/">Back to Dashboard</a></div>
</form><p>${updated}</p></main></html>`);
}
