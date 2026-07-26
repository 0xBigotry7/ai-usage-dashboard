# Provider development

## Adapter contract

A local adapter exports an async collection function:

```js
export async function collectExampleUsage(env = process.env) {
  return {
    id: "example-ai",
    name: "Example AI",
    shortName: "EA",
    accent: "#8bb8ff",
    state: "ready",
    plan: "Pro",
    source: "Example API",
    sourceKind: "api_key",
    updatedAt: new Date().toISOString(),
    windows: [],
    balance: null,
    message: null,
    tokenUsage: null,
    tokenEstimates: []
  };
}
```

Register it in `collector/providers/index.mjs`.

## Required behavior

- Use a stable lowercase ID matching `^[a-z0-9][a-z0-9_-]{0,31}$`.
- Never return credentials, account IDs, hostnames, paths, prompts, or raw
  provider responses.
- Preserve missing data as `null` or an absent window.
- Use `providerError()` for consistent authentication and connection states.
- Validate credential-free HTTPS overrides before fetching.
- Add timeouts to network calls.

## Windows

Each window contains:

```ts
{
  id: string;
  label: string;
  durationSeconds: number;
  usedPercent: number | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null;
}
```

Do not reconstruct a percentage when the provider does not supply enough
information. Reset-time inference belongs to the shared UI and only runs after
an observed history drop.

## Token estimates

Use `quota_percentage` when multiplying a real weekly percentage by a
configured capacity. Use `session_logs` only for local numeric token counters.
Use `api_usage` for exact tokens returned by a documented usage endpoint; set
`estimated: false` and include `requestCount` when available. Keep methods
separate in `tokenEstimates[]`; do not add overlapping scopes.

Every new token method should declare a stable `periodId` and `scope`. Current
values are `today`, `weekly_cycle`, `rolling_7d`, and `weekly_quota`, with
`local_device`, `account`, or `calibrated_quota` scope. When the provider
supplies a breakdown, maintain `totalTokens = inputTokens + outputTokens`;
cached input and reasoning output are subsets, not additional totals.

```js
{
  basis: "api_usage",
  periodId: "rolling_7d",
  scope: "account",
  estimated: false,
  totalTokens: 123456,
  inputTokens: 120000,
  outputTokens: 3456,
  periodSeconds: 604800,
  requestCount: 42,
  models: [
    {
      id: "example-model",
      label: "example-model",
      estimatedTokens: 123456,
      requestCount: 42,
      countedInTotal: true
    }
  ],
  assumption: "Exact usage returned by the provider API."
}
```

## Registry and configuration

Add the adapter to `providerAdapters` in `collector/providers/index.mjs`.
Default adapters may use `defaultEnabled: true`. Optional adapters should
provide a credential-presence predicate:

```js
{
  id: "example-ai",
  name: "Example AI",
  configured: (env) => Boolean(env.EXAMPLE_API_KEY?.trim()),
  collect: collectExampleUsage
}
```

Do not render every unsupported provider as an error card. An optional adapter
should disappear cleanly until configured.

## Testing checklist

- successful normalization;
- missing windows;
- authentication error;
- malformed or partial provider response;
- sanitizer rejects extra secret-like fields;
- desktop and compact rendering;
- `npm run check`.

All fixtures must be synthetic.
