import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("built Workers runtime renders both views and rejects unauthorized requests", { timeout: 60_000 }, async (t) => {
  // Use an ephemeral loopback port; never attach to the user's dashboard or
  // collector. No provider sessions or actual account data are used.
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:USAGE_HUB_|CLOUDFLARE_|CF_|VIEW_TOKEN$|INGEST_TOKEN$)/.test(key),
  ));
  const child = spawn(process.execPath, [
    path.join(root, "node_modules/vite/bin/vite.js"), "preview",
    "--host", "127.0.0.1", "--port", String(port), "--strictPort",
  ], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = (output + chunk).slice(-8_000); });
  }
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { await closed; } finally { clearTimeout(force); }
  });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Preview exited: ${output}`);
    try {
      const response = await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(1_000) });
      ready = response.ok;
      await response.arrayBuffer();
      if (ready) break;
    } catch { /* wait for the isolated runtime */ }
    await delay(250);
  }
  assert.ok(ready, `Preview failed to start: ${output}`);
  for (const route of ["/", "/display"]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200, route);
    assert.match(await response.text(), /AI Usage Dashboard/);
  }
  for (const route of ["/api/usage", "/api/history"]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 401, route);
    assert.match(response.headers.get("cache-control"), /no-store/);
    await response.arrayBuffer();
  }
  for (const [route, body] of [["/api/ingest", {}], ["/api/session", { code: "synthetic-invalid-code" }]]) {
    const response = await fetch(origin + route, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 401, route);
    await response.arrayBuffer();
  }
});
