import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decodeJwtPayload,
  describeDurationAgo,
  jwtExpiresAtMs,
} from "../collector/jwt.mjs";
import { collectCodexUsage } from "../collector/providers/codex.mjs";

function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeJwt(claims) {
  const header = encodeSegment({ alg: "none", typ: "JWT" });
  const signature = Buffer.from("synthetic-signature").toString("base64url");
  return `${header}.${encodeSegment(claims)}.${signature}`;
}

function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(url, options);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function withCodexHome(authJson, run) {
  const codexHome = await mkdtemp(join(tmpdir(), "usage-codex-jwt-test-"));
  try {
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify(authJson),
      "utf8",
    );
    return await run({
      CODEX_HOME: codexHome,
      USAGE_HUB_CODEX_LOG_ESTIMATE: "off",
    });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

test("decodeJwtPayload reads claims and rejects non-JWT input", () => {
  const claims = { exp: 1_700_000_000, sub: "user" };
  assert.deepEqual(decodeJwtPayload(fakeJwt(claims)), claims);
  assert.equal(decodeJwtPayload("not-a-jwt"), null);
  assert.equal(decodeJwtPayload("a.b"), null);
  assert.equal(decodeJwtPayload(".."), null);
  assert.equal(decodeJwtPayload(null), null);
  assert.equal(decodeJwtPayload(`x.${encodeSegment([1, 2])}.y`), null);
});

test("jwtExpiresAtMs converts exp to milliseconds and rejects junk", () => {
  assert.equal(jwtExpiresAtMs(fakeJwt({ exp: 1_700_000_000 })), 1_700_000_000_000);
  assert.equal(jwtExpiresAtMs(fakeJwt({ sub: "no-exp" })), null);
  assert.equal(jwtExpiresAtMs(fakeJwt({ exp: "soon" })), null);
  assert.equal(jwtExpiresAtMs(fakeJwt({ exp: 0 })), null);
  assert.equal(jwtExpiresAtMs("garbage"), null);
});

test("describeDurationAgo picks the granularity a login message needs", () => {
  assert.equal(describeDurationAgo(30 * 60 * 1000), "less than an hour ago");
  assert.equal(describeDurationAgo(90 * 60 * 1000), "1 hour ago");
  assert.equal(describeDurationAgo(26 * 3_600_000), "26 hours ago");
  assert.equal(describeDurationAgo(3 * 24 * 3_600_000 + 5_000), "3 days ago");
});

test("an expired codex JWT yields a precise message without a network call", async () => {
  const expiredAt = Math.floor(Date.now() / 1000) - 26 * 3600;
  const mock = mockFetch(() => {
    throw new Error("network must not be reached for an expired token");
  });
  try {
    const result = await withCodexHome(
      {
        tokens: {
          access_token: fakeJwt({ exp: expiredAt }),
          account_id: "synthetic-account",
        },
      },
      (env) => collectCodexUsage(env),
    );
    assert.equal(result.state, "auth_error");
    assert.equal(
      result.message,
      "Codex login expired 26 hours ago — run any codex command on this machine to re-login.",
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("an unexpired codex JWT still reaches the usage endpoint", async () => {
  const validJwt = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const mock = mockFetch(() =>
    new Response(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            limit_window_seconds: 18_000,
            used_percent: 12.5,
            reset_at: Math.floor(Date.now() / 1000) + 600,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  try {
    const result = await withCodexHome(
      { tokens: { access_token: validJwt, account_id: "synthetic-account" } },
      (env) => collectCodexUsage(env),
    );
    assert.equal(result.state, "ready");
    assert.equal(mock.calls.length, 1);
    assert.equal(
      mock.calls[0].options.headers.Authorization,
      `Bearer ${validJwt}`,
    );
  } finally {
    mock.restore();
  }
});

test("a server-side 401 with an unexpired JWT keeps the generic sign-in message", async () => {
  const validJwt = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const mock = mockFetch(() =>
    new Response(JSON.stringify({ detail: "invalid" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    const result = await withCodexHome(
      { tokens: { access_token: validJwt } },
      (env) => collectCodexUsage(env),
    );
    assert.equal(result.state, "auth_error");
    assert.match(result.message, /Codex sign-in has expired/);
  } finally {
    mock.restore();
  }
});
