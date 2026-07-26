# Security model and limitations

## Security goals

Provider credentials should never enter:

- Git or build artifacts;
- the browser;
- SQLite or D1;
- sanitized snapshots;
- application logs.

These goals depend on keeping real values outside source-controlled files.

## Credential handling

- Codex credentials are read from the existing CLI file and never modified.
- Kimi keys are entered through a non-echoing prompt and stored in
  `~/.usage-hub/env` with mode `0600`.
- Hosted ingest and viewer credentials are separate.
- `.env*`, `.openai/hosting.json`, private overlays, local databases, logs, and
  generated secret files are ignored by Git.

## Local log estimator

The Codex log estimator reads only lines containing `token_count`,
`turn_context`, or `session_meta`. It extracts numeric cumulative token
counters, a bounded model label, and only the rollout IDs/relationship fields
needed to recognize inherited counters. It does not include raw events in API
responses, SQLite, D1, or logs. Counting follows counter deltas per session
file, deduplicates resumed or forked sessions that inherit a parent counter,
and aligns the window with the subscription quota cycle embedded in the events
(falling back to the past seven days). Totals include cached input reads,
broken out separately as `cachedInputTokens`.

This is a data-minimization property, not a filesystem sandbox: the local
process still has the permissions of the user who starts it. Disable the scan
with `USAGE_HUB_CODEX_LOG_ESTIMATE=off` when that access is undesirable.

## Network boundaries

- The local collector listens only on loopback and rejects requests whose
  `Host` header is not `127.0.0.1`, `localhost`, or `[::1]` on its port.
- Provider overrides and cloud URLs must be credential-free HTTPS URLs.
- The hosted ingest endpoint requires a bearer token and limits requests to
  64 KiB.
- Hosted usage responses require a viewer session and disable caching.
- Local SQLite and hosted D1 history are pruned automatically; only the most
  recent 31 days of samples are retained.

The viewer code is suitable for a personal dashboard, not a multi-tenant
service. There is no account system, RBAC, audit log, or built-in brute-force
rate limiter. Put a public deployment behind Cloudflare Access or another
identity layer when stronger controls are needed.

## Snapshot minimization

`sanitizeRemoteSnapshot()` constructs new objects from accepted fields. It
does not pass unknown properties through. It bounds:

- provider, window, and model identifiers;
- string lengths;
- token counts and percentages;
- provider/window/model counts;
- timestamps and request size.

Hostnames, paths, raw events, prompts, completions, message IDs, access tokens,
refresh tokens, and API keys are not in the accepted schema.

## Provider endpoint risk

The included quota adapters use endpoints observed in official clients:

- Codex: `https://chatgpt.com/backend-api/wham/usage`
- Kimi Code: `https://api.kimi.com/coding/v1/usages`

They are not documented as stable third-party APIs. Authentication, response
shapes, rate limits, or availability can change without notice. A provider
error is a compatibility signal, not proof that an account has no quota.

Use of provider accounts remains subject to the provider's current terms and
regional availability. This project does not bypass regional restrictions.

## Estimate limitations

Quota conversion appears only after the user configures a calibration capacity;
there is no default, and the value is not an official limit. Local log
estimates previously double-counted resumed or forked sessions and could
undercount when an event was lost between samples; both are corrected by
counter-delta accounting with inherited-counter detection. Local logs can
still be incomplete across devices, deleted sessions, or nested agent work.
Neither method is an invoice, subscription entitlement, compliance record, or
safe spending control.

## Reporting a vulnerability

Follow [SECURITY.md](../SECURITY.md). Do not publish credentials, private usage
data, raw logs, or a live vulnerable deployment in an issue.
