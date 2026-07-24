# Roadmap

## Near term

- Extract the custom snapshot JSON Schema for third-party collectors.
- Add adapter capability metadata and per-provider enable/disable settings.
- Add warning thresholds and optional notifications.
- Add fixture-based compatibility monitoring for unstable provider endpoints.

## Provider expansion candidates

These are research directions, not current support:

1. **ccusage JSON adapter** — reuse its provider-neutral CLI output instead of
   reimplementing log parsers for every supported coding agent.
2. **Gemini CLI** — ingest model/session statistics exposed by its documented
   `/stats model` behavior or a stable local record.
3. **GitHub Copilot CLI** — ingest per-model session usage when a stable
   non-interactive source is available.
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

The provider breadth in
[CodexBar](https://github.com/steipete/CodexBar) and the local-log coverage in
[ccusage](https://github.com/ryoppippi/ccusage) are useful references. No future
adapter should copy code without license review and explicit attribution.
