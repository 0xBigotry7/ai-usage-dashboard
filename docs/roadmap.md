# Roadmap

The project is intentionally capability-led. Adding a provider is valuable only
when its data source is trustworthy and it adds a useful signal. A long list of
logos backed by fragile scraping is not a product goal.

## Shipped in 0.8.0

- Native AppKit status item that keeps the first three providers visible in the
  menu bar, including explicit failure and stale-data states.
- Three-provider summary strip, branded provider cards, stable macOS Tahoe menu
  placement, and complete real quota-window details.
- Pace projections when a provider supplies both a real reset time and window
  duration, plus opt-in, cycle-deduplicated 70% / 80% / 90% alerts.
- Codex only renders windows supplied by the collector; the dashboard and menu
  app do not invent a five-hour quota.

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

1. **Predictive alerts and health controls** — add acceleration-aware
   forecasting, collector-outage and stale-data alerts, per-provider controls,
   and configurable cooldowns.
2. **Standardized capability schema** — let adapters declare quota windows,
   exact tokens, estimates, balances, costs, history, and refresh guarantees so
   every client can render unsupported fields honestly.
3. **Physical display integrations** — publish a stable, minimal endpoint and
   reference client for [AWTRIX 3](https://github.com/blueforcer/awtrix3) /
   Ulanzi TC001-class pixel displays without sending provider credentials to
   the device.
4. **Distributable macOS releases** — Developer ID signing, notarization,
   release checksums, and an optional Homebrew cask. Local ad-hoc builds remain
   available.
5. **Schema and endpoint resilience** — extract the custom snapshot JSON
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
