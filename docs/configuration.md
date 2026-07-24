# Configuration and deployment

## Requirements

- macOS or Linux;
- Node.js 22.13 or newer;
- logins or keys only for the providers you enable.

No provider is mandatory. One adapter can fail while the others continue.

## Local dashboard

```bash
npm ci
npm run local
```

Open <http://localhost:3000>. The collector binds only to
`127.0.0.1:4317`.

Local private state:

| Path | Purpose |
| --- | --- |
| `~/.usage-hub/env` | Kimi, token calibration, and cloud-sync settings; mode `0600` |
| `~/.usage-hub/usage.db` | Normalized local history; no credentials |
| `~/.usage-hub/view-code` | Optional hosted viewer code; mode `0600` |

### Codex

Log in with the official Codex CLI. The adapter reads the existing
`~/.codex/auth.json` and never modifies it.

The local Token estimate scans `~/.codex/sessions/**/*.jsonl`, but parses only
`token_count` and `turn_context` model metadata lines. Disable it with:

```bash
USAGE_HUB_CODEX_LOG_ESTIMATE=off npm run local
```

Set `CODEX_HOME` if the CLI data directory is elsewhere.

### Kimi Code

```bash
npm run configure:kimi
```

The helper hides input and updates only `KIMI_CODE_API_KEY` in
`~/.usage-hub/env`. Without a key, an unexpired Kimi CLI session is used as a
temporary fallback.

### Token-capacity calibration

Quota conversion defaults to 10,000,000 tokens per week for each included
adapter. These are display calibrations, not official limits.

```text
USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY=10000000
USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY=10000000
```

## Optional Cloudflare deployment

The repository builds a vinext application for Cloudflare Workers and uses a D1
binding named `DB`.

1. Authenticate and create D1:

   ```bash
   npx wrangler login
   npx wrangler d1 create ai-usage-dashboard
   ```

2. Apply the schema:

   ```bash
   npx wrangler d1 execute ai-usage-dashboard \
     --remote \
     --file=drizzle/0000_blushing_ravenous.sql
   ```

3. Generate separate ingest and viewer secrets:

   ```bash
   npm run generate:cloud-secrets
   ```

4. Build and deploy, replacing the example UUID:

   ```bash
   USAGE_HUB_D1_DATABASE_NAME=ai-usage-dashboard \
   USAGE_HUB_D1_DATABASE_ID=00000000-0000-0000-0000-000000000000 \
   npm run build

   npx wrangler deploy \
     --config dist/server/wrangler.json \
     --secrets-file ~/.usage-hub/cloud-secrets.json
   ```

5. Point the local collector at the deployed ingest endpoint:

   ```bash
   npm run configure:cloud -- https://dashboard.example/api/ingest
   ```

Restart `npm run local`, then use the generated viewer code on the hosted page.

## Custom and private collectors

Custom collectors are intentionally outside this repository. They can send a
normalized provider without revealing how that provider was accessed:

```bash
curl -X POST https://dashboard.example/api/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  --data @sanitized-snapshot.json
```

Use synthetic data while developing. Never place a real ingest token in a shell
history, fixture, issue, or repository.

The full provider object is documented in
[Provider development](provider-development.md). The server sanitizer is the
final authority: unknown fields are discarded, payloads are limited to 64 KiB,
and only credential-free normalized values are stored.

## Environment reference

| Variable | Process | Meaning |
| --- | --- | --- |
| `KIMI_CODE_API_KEY` | local collector | Optional long-lived Kimi key |
| `KIMI_CODE_BASE_URL` | local collector | Optional credential-free HTTPS base URL |
| `CODEX_HOME` | local collector | Optional Codex data directory |
| `KIMI_CODE_HOME` | local collector | Optional Kimi data directory |
| `USAGE_HUB_CODEX_LOG_ESTIMATE` | local collector | Set to `off` to disable local log estimation |
| `USAGE_HUB_PUSH_URL` | local collector | Hosted `/api/ingest` endpoint |
| `USAGE_HUB_PUSH_TOKEN` | local collector | Hosted ingest bearer secret |
| `USAGE_HUB_CLOUD_URL` | local collector | Optional hosted root URL for merging additional sanitized providers |
| `USAGE_HUB_VIEW_CODE_FILE` | local collector | Optional viewer-code path |
| `USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY` | local collector | Codex quota-conversion calibration |
| `USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY` | local collector | Kimi quota-conversion calibration |
| `INGEST_TOKEN` | hosted Worker | Secret accepted by `/api/ingest` |
| `VIEW_TOKEN` | hosted Worker | Code used to create a viewer session |
| `USAGE_HUB_D1_DATABASE_ID` | build | D1 database UUID |
| `USAGE_HUB_D1_DATABASE_NAME` | build | D1 database name |
