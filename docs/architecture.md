# Architecture

AI Usage Dashboard separates collection, normalization, storage, and display.
Provider credentials stay with the process that owns them.

```mermaid
flowchart LR
  A["Provider adapter"] --> B["Normalized provider object"]
  C["Local session-log estimator"] --> B
  B --> D["Loopback collector"]
  D --> E["SQLite history"]
  D --> F["Local dashboard"]
  D --> K["/display always-on view"]
  D --> J["macOS menu bar"]
  D -. "sanitized HTTPS push" .-> G["Cloudflare Worker + D1"]
  H["Private or third-party collector"] -. "same normalized schema" .-> G
  G --> I["Authenticated hosted dashboard"]
```

## Components

### Provider adapters

`collector/providers/index.mjs` is the local registry. Each adapter:

1. reads a provider-owned login or a private user configuration;
2. fetches quota data;
3. normalizes windows, reset times, balance, and status;
4. attaches zero or more independent token estimates.

The included adapters are Codex, Kimi Code, OpenAI Organization Usage,
OpenRouter, DeepSeek balance, and GitHub Copilot AI Credits. Optional
documented-API adapters are enabled only when their local configuration exists.
New adapters do not require UI changes when they follow the normalized schema.

### Local collector

`collector/server.mjs`:

- binds to `127.0.0.1:4317` and rejects requests whose `Host` header is not
  loopback (`127.0.0.1`, `localhost`, or `[::1]`);
- refreshes adapters concurrently;
- exposes current usage, seven-day history, and manual refresh;
- stores normalized history in `~/.usage-hub/usage.db`, pruning rows older
  than 31 days;
- optionally pushes a sanitized snapshot to an HTTPS endpoint;
- optionally merges additional sanitized providers from the hosted dashboard.

Providers read back from the cloud are tagged `remote_snapshot` and excluded
from the next outbound push, preventing loops.

### Token estimators

The normalized provider object can contain `tokenEstimates[]`.

`api_usage` contains exact model token counters returned by a documented
provider usage endpoint. It sets `estimated: false` and may attach a request
count.

`quota_percentage` multiplies the provider's weekly percentage by a configured
capacity. It can represent account-wide usage but relies on a calibration
assumption. There is no built-in capacity: the estimate is only produced when
the user sets `USAGE_HUB_*_WEEKLY_TOKEN_CAPACITY`, otherwise the quota
percentage is shown alone.

`session_logs` scans local Codex JSONL files for `token_count` and model metadata
events. It sums cumulative-counter deltas over the current subscription window,
aligned with the weekly quota cycle embedded in the log events and falling back
to the past seven days when no window is found. Resumed or forked sessions that
inherit a parent counter are deduplicated. The reported `totalTokens` includes
cached input reads, with the cached-read portion broken out as
`cachedInputTokens`. It does not inspect or export message bodies. It covers
this machine only and can miss other devices and deleted logs.

The UI compares these methods and never adds them together.

### Display clients

The responsive React dashboard is the full analysis client. Provider toggles,
warning thresholds, and copied summaries are browser-local preferences and do
not change collection. Built-in providers use local SVG artwork; custom
providers fall back to their normalized `shortName`.

`/display` is a separate React surface for 480×320 and 800×480 always-on
screens. It prioritizes quota windows, reset times, balances, available model
tokens, and freshness over dashboard controls. It shows three providers per
page below 680 pixels and four at larger widths, rotating pages every eight
seconds. Fullscreen and Screen Wake Lock are explicit user actions. The route
uses the same authenticated API and normalized data as the dashboard; it
introduces no additional collection or credential path.

The native macOS menu bar companion is a second read-only client. It polls the
loopback API once per minute and never queries providers or stores credentials
itself. Its label summarizes the primary quota for up to three providers. The
popover renders every returned quota window, balances and freshness, plus the
three largest available per-model token totals for each provider. A stale or
unreachable collector adds a visible warning. Launch-at-login registration is
handled locally with macOS `SMAppService`.

### Freshness and honest absence

A provider update older than the client freshness threshold is labeled stale;
its last data remains visible so an outage is not confused with zero usage.
Risk is derived from the highest available quota window, not only the weekly
window. If there are not enough real history points to draw a trend, the
dashboard says that history is still accumulating instead of fabricating a
line. Missing quota capacities and model-level data remain “not provided.”

### Reset-time inference

When a provider omits `resetsAt`, the dashboard may estimate the next reset only
after sanitized history shows an actual percentage drop for that exact window.
The midpoint between the last pre-reset and first post-reset samples becomes
the anchor. The UI advances by the provider-reported duration and labels the
result as estimated. Without an observed drop, the time remains unknown.

### Hosted application

The Cloudflare deployment uses:

- `/api/ingest` for bearer-authenticated snapshot writes;
- `/api/session` to exchange a viewer code for a secure cookie;
- `/api/usage` and `/api/history` for authenticated reads;
- D1 for current provider rows and bounded history.

The ingest route stores providers independently, so collectors can update at
different times. Both ingest and local history keep only the most recent 31
days of samples; older rows are pruned automatically. The `/api/history`
response includes a `truncated` flag that is true when the 10,000-row response
limit cut off older points within the requested range.

## Normalized schema

A minimal provider looks like:

```json
{
  "id": "example-ai",
  "name": "Example AI",
  "shortName": "EA",
  "accent": "#8bb8ff",
  "state": "ready",
  "plan": "Pro",
  "source": "Example collector",
  "sourceKind": "custom",
  "updatedAt": "2026-07-24T12:00:00.000Z",
  "windows": [
    {
      "id": "weekly",
      "label": "This week",
      "durationSeconds": 604800,
      "usedPercent": 32,
      "used": null,
      "limit": null,
      "remaining": null,
      "resetsAt": "2026-07-27T00:00:00.000Z"
    }
  ],
  "balance": null,
  "message": null,
  "tokenEstimates": [
    {
      "basis": "quota_percentage",
      "estimated": true,
      "totalTokens": 3200000,
      "capacityTokens": 10000000,
      "usedPercent": 32,
      "windowId": "weekly",
      "models": [
        {
          "id": "example-subscription",
          "label": "Example subscription",
          "windowId": "weekly",
          "usedPercent": 32,
          "capacityTokens": 10000000,
          "estimatedTokens": 3200000,
          "countedInTotal": true
        }
      ],
      "assumption": "Weekly percentage multiplied by configured capacity."
    }
  ]
}
```

The sanitizer accepts provider IDs matching
`^[a-z0-9][a-z0-9_-]{0,31}$`, bounded display fields, up to eight windows, and
up to four token estimates. Unknown properties are discarded.

## Data minimization

| Boundary | Allowed | Rejected |
| --- | --- | --- |
| Adapter to local collector | Normalized usage plus in-memory credentials used by that adapter | Nothing is forwarded automatically |
| Collector to cloud ingest | Provider display fields, status, numeric usage, reset times, estimates | Tokens, keys, hostnames, paths, raw logs, messages |
| Cloud to browser | Sanitized current rows and history after viewer authentication | Ingest secret and provider credentials |

All usage responses use `Cache-Control: private, no-store`.

Bundled provider SVGs are static presentation assets and are never interpreted
as provider endpoints. The mapping from normalized provider ID to artwork is a
fixed local allowlist.

## Public/private boundary

The public repository contains the provider-neutral snapshot contract, not
machine-specific collectors or private account workflows. A private collector
can run anywhere appropriate and send only the normalized object above.
