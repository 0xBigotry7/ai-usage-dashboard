/**
 * Minimal local JWT payload inspection.
 *
 * Decodes the (unverified) payload of a JWT purely to read public claims
 * such as `exp` — used to tell the user precisely when a stored login
 * expired. No signature verification is attempted and nothing here mints,
 * refreshes, or writes credentials.
 *
 * Deliberately NOT implemented: refreshing the Codex OAuth session. The
 * codex CLI's refresh tokens are single-use (rotating) — the auth backend
 * rejects a replayed refresh token with `refresh_token_reused` and forces a
 * re-login — and the CLI may persist rotated tokens to the OS keyring
 * instead of auth.json depending on its `cli_auth_credentials_store`
 * setting. A second refresher outside the CLI therefore risks invalidating
 * the user's real session. See docs/security.md.
 */

export function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return null;
  }
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(payload);
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

/**
 * The token's `exp` claim as epoch milliseconds, or null when the token is
 * not a decodable JWT or carries no usable expiry.
 */
export function jwtExpiresAtMs(token) {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) {
    return null;
  }
  return exp * 1000;
}

/**
 * Human phrasing for how long ago something happened, at the granularity a
 * "login expired" message needs: hours below two days, days beyond that.
 */
export function describeDurationAgo(milliseconds) {
  const hours = Math.floor(milliseconds / 3_600_000);
  if (hours < 1) return "less than an hour ago";
  if (hours === 1) return "1 hour ago";
  if (hours < 48) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}
