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
Keep estimates separate in `tokenEstimates[]`; do not add overlapping methods.

## Testing checklist

- successful normalization;
- missing windows;
- authentication error;
- malformed or partial provider response;
- sanitizer rejects extra secret-like fields;
- desktop and compact rendering;
- `npm run check`.

All fixtures must be synthetic.
