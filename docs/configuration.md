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
| `~/.usage-hub/env` | Provider keys, token calibration, and cloud-sync settings; mode `0600` |
| `~/.usage-hub/usage.db` | Normalized local history; no credentials |
| `~/.usage-hub/view-code` | Optional hosted viewer code; mode `0600` |

### Codex

Log in with the official Codex CLI. The adapter reads the existing
`~/.codex/auth.json` and never modifies it.

The local Token estimate scans `~/.codex/sessions/**/*.jsonl`, but parses only
`token_count`, `turn_context` model metadata, and the `session_meta` IDs and
relationship fields needed for fork/resume deduplication. The counting window
is reported twice: once from local midnight and once for the subscription quota
cycle embedded in the log events (falling back to the trailing seven days).
Replayed ancestor prefixes in resumed or forked rollouts are removed before
novel child turns are counted. Input and output form the total; cached input and
reasoning output are retained only as non-additive breakdowns.
Disable it with:

```bash
USAGE_HUB_CODEX_LOG_ESTIMATE=off npm run local
```

Set `CODEX_HOME` if the CLI data directory is elsewhere.

### Claude Code

No configuration is required. The adapter enables itself when
`~/.claude/projects` exists and reads the local Claude Code session logs
(`~/.claude/projects/**/*.jsonl`). Set `CLAUDE_CONFIG_DIR` if Claude Code
stores its data elsewhere; the logs are then read from
`$CLAUDE_CONFIG_DIR/projects`. No credential is read or written.

Only the numeric per-message `usage` fields, model IDs, timestamps, and the
record IDs needed for retry deduplication are parsed. Prompts, replies, and
tool output are never read. Entries logged more than once for the same API
call are deduplicated, and subagent turns are included. Observed totals are
reported twice: once from local midnight and once for the trailing seven days.
Claude Code exposes no documented quota endpoint, so this adapter shows
observed tokens only and does not invent a quota window, percentage, or reset
time. Disable it with:

```bash
USAGE_HUB_CLAUDE_LOG_ESTIMATE=off npm run local
```

### Kimi Code

```bash
npm run configure:kimi
```

The helper hides input and updates only `KIMI_CODE_API_KEY` in
`~/.usage-hub/env`. Without a key, an unexpired Kimi CLI session is used as a
temporary fallback.

### Documented API adapters

Each optional adapter is enabled automatically only after its required
configuration exists:

```bash
npm run configure:provider -- openai-api
npm run configure:provider -- openrouter
npm run configure:provider -- deepseek
npm run configure:provider -- github-copilot
```

The helper hides secret fields and updates `~/.usage-hub/env` with mode `0600`.
It never prints a saved key.

- **OpenAI API** requires an Admin API Key with access to Organization Usage.
  It reports exact model tokens and requests over the past seven days. A normal
  project API key cannot access this endpoint.
- **OpenRouter** reports spend and limits for the configured key. Its window is
  daily, weekly, or monthly according to the key's `limit_reset`.
- **DeepSeek API** reports the account balance. Its documented endpoint does
  not return a subscription quota window.
- **GitHub Copilot** uses the user AI Credits billing endpoint. The fine-grained
  token needs only `Plan: read`. User-level billing covers a personally billed
  Copilot plan; organization-managed seats require an organization endpoint
  and are not included by this adapter. Set the optional monthly credit limit
  only if you want a percentage gauge.

To override auto-discovery, select adapters explicitly:

```text
USAGE_HUB_PROVIDERS=codex,kimi,openrouter,deepseek
```

### macOS menu bar

The menu bar companion reads `http://127.0.0.1:4317/api/usage` and therefore
needs a local collector. The packaged app built below includes and starts that
collector automatically; only `npm run menubar` development runs require a
separate `npm run collector` process.

```bash
npm run build:menubar
open "dist/AI Usage Dashboard Menu Bar.app"
```

It targets macOS 14 or newer and contains no provider SDKs or credentials.

### Token-capacity calibration

Quota conversion has no built-in capacity. Set a calibration value to enable a
converted token estimate; when unset, the dashboard shows only the provider's
quota percentage. These values are your own display calibrations, not official
limits.

```text
USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY=
USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY=
```

The helper command atomically updates only the selected capacity assignment in
the private local env file, preserving comments and other credential lines. It
also respects `USAGE_HUB_ENV_FILE`:

```bash
npm run configure:capacity -- kimi 10000000
npm run configure:capacity -- kimi clear
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
| `OPENAI_ADMIN_KEY` | local collector | Optional OpenAI Organization Usage Admin key |
| `OPENROUTER_API_KEY` | local collector | Optional OpenRouter key |
| `DEEPSEEK_API_KEY` | local collector | Optional DeepSeek key |
| `GITHUB_COPILOT_USERNAME` | local collector | User whose personally billed AI Credits are queried |
| `GITHUB_COPILOT_TOKEN` | local collector | Fine-grained token with `Plan: read` |
| `GITHUB_COPILOT_MONTHLY_CREDIT_LIMIT` | local collector | Optional local comparison limit |
| `USAGE_HUB_PROVIDERS` | local collector | Optional explicit comma-separated adapter IDs |
| `CODEX_HOME` | local collector | Optional Codex data directory |
| `CLAUDE_CONFIG_DIR` | local collector | Optional Claude Code data directory; session logs are read from `$CLAUDE_CONFIG_DIR/projects` |
| `KIMI_CODE_HOME` | local collector | Optional Kimi data directory |
| `USAGE_HUB_CODEX_LOG_ESTIMATE` | local collector | Set to `off` to disable Codex local log estimation |
| `USAGE_HUB_CLAUDE_LOG_ESTIMATE` | local collector | Set to `off` to disable Claude Code local log estimation |
| `USAGE_HUB_PUSH_URL` | local collector | Hosted `/api/ingest` endpoint |
| `USAGE_HUB_PUSH_TOKEN` | local collector | Hosted ingest bearer secret |
| `USAGE_HUB_CLOUD_URL` | local collector | Optional hosted root URL for merging additional sanitized providers |
| `USAGE_HUB_VIEW_CODE_FILE` | local collector | Optional viewer-code path |
| `USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY` | local collector | Optional Codex quota-conversion calibration; unset disables the converted estimate |
| `USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY` | local collector | Optional Kimi quota-conversion calibration; unset disables the converted estimate |
| `USAGE_HUB_HOST` | local collector | Optional bind address (default `127.0.0.1`) |
| `USAGE_HUB_PORT` | local collector | Optional bind port (default `4317`) |
| `USAGE_HUB_POLL_INTERVAL_MS` | local collector | Optional local scheduler tick in ms (default `60000`, minimum `30000`); provider APIs are independently capped at one request per five minutes |
| `USAGE_HUB_DB` | local collector | Optional local history database path |
| `USAGE_HUB_ENV_FILE` | local collector | Optional private env file path |
| `INGEST_TOKEN` | hosted Worker | Secret accepted by `/api/ingest` |
| `VIEW_TOKEN` | hosted Worker | Code used to create a viewer session |
| `USAGE_HUB_D1_DATABASE_ID` | build | D1 database UUID |
| `USAGE_HUB_D1_DATABASE_NAME` | build | D1 database name |


## Disabling specific providers

`USAGE_HUB_DISABLE_PROVIDERS` pins providers off without listing everything
else. It wins over both auto-detection and an explicit `USAGE_HUB_PROVIDERS`
list. Typical use: a laptop whose Claude Code usage is already reported by
another machine through cloud sync should not double-count its local logs:

```bash
USAGE_HUB_DISABLE_PROVIDERS=claude npm run local
```

The value is a comma-separated list of provider ids and can live in
`~/.usage-hub/env`.
