# Roadmap

The project is intentionally capability-led. Adding a provider is valuable only
when its data source is trustworthy and it adds a useful signal. A long list of
logos backed by fragile scraping is not a product goal.

## Shipped in 0.7.0

- Dedicated `/display` surface for 480×320 and 800×480 always-on screens, with
  automatic paging, fullscreen, and Screen Wake Lock controls.
- Native macOS menu-bar summaries for up to three providers, complete window
  details, stale-data warnings, available model-token totals, and a
  launch-at-login switch.
- Locally bundled provider artwork with text fallback for custom providers.
- Honest stale states and history placeholders instead of treating old or
  absent data as current zero usage.

## Highest-value next steps

1. **Pace and burn-down** — compare consumption against time elapsed in each
   quota window, forecast exhaustion, and distinguish “high but on pace” from
   “low but accelerating.”
2. **Standardized capability schema** — let adapters declare quota windows,
   exact tokens, estimates, balances, costs, history, and refresh guarantees so
   every client can render unsupported fields honestly.
3. **Actionable notifications** — native notifications for threshold crossing,
   projected exhaustion, collector outages, and stale data, with per-provider
   controls and cooldowns.
4. **Physical display integrations** — publish a stable, minimal endpoint and
   reference client for [AWTRIX 3](https://github.com/blueforcer/awtrix3) /
   Ulanzi TC001-class pixel displays without sending provider credentials to
   the device.
5. **Distributable macOS releases** — Developer ID signing, notarization,
   release checksums, and an optional Homebrew cask. Local ad-hoc builds remain
   available.
6. **Schema and endpoint resilience** — extract the custom snapshot JSON
   Schema, add fixtures for unstable provider endpoints, and expose adapter
   capability metadata through collector discovery.

## Provider expansion candidates

These are research directions, not commitments. Each candidate must pass the
design rules below before it becomes built-in support:

1. **ccusage JSON adapter** — reuse its provider-neutral CLI output instead of
   reimplementing log parsers for every supported coding agent.
2. **Gemini CLI** — ingest model/session statistics exposed by its documented
   `/stats model` behavior or a stable local record.
3. **GitHub organization AI Credits** — extend the existing personally billed
   user adapter for organization-managed seats without broadening default
   token permissions.
4. **Cursor** — prefer documented team/enterprise APIs over browser-cookie
   extraction.
5. **OpenCode, Kilo, Qwen, MiniMax, and other coding agents** — add through
   isolated adapters or the custom snapshot protocol.

## Design rules for expansion

- Public or documented APIs are preferred.
- Local logs must be parsed without exporting message content.
- Browser-cookie extraction is not a default integration strategy.
- Every adapted implementation must be credited with its license.
- A provider can fail without blocking the rest of the dashboard.
- Quota, observed tokens, estimated cost, and subscription limits remain
  separate concepts.
- Missing capability data stays visibly absent; adapters must not fabricate a
  normalized percentage only to fit the UI.
- New adapters should be isolated and fixture-tested before they are enabled by
  default.

The provider breadth in
[CodexBar](https://github.com/steipete/CodexBar) and the local-log coverage in
[ccusage](https://github.com/ryoppippi/ccusage) are useful references. No future
adapter should copy code without license review and explicit attribution.
