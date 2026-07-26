# AI Usage Dashboard

[![CI](https://github.com/0xBigotry7/ai-usage-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/0xBigotry7/ai-usage-dashboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-5FA04E.svg)](package.json)

<img src="public/og.png" alt="AI Usage Dashboard showing provider quota windows, balances, and token estimates" width="1731">

A local-first, extensible dashboard for AI quota windows, official API usage,
balances, and token estimates. It includes a responsive web dashboard, a
purpose-built always-on display, and a native macOS menu bar companion.

[中文说明](README.zh-CN.md)

## Why this project exists

AI coding tools expose usage in different places and formats. This project
normalizes those signals into one small dashboard without sending provider
credentials or raw conversations to the browser.

It deliberately separates these concepts:

- **quota**: the percentage and reset time returned by a provider;
- **official API usage**: exact model tokens or credits reported by a documented
  billing endpoint;
- **observed tokens**: token counters found in local CLI session logs;
- **token equivalent**: a configurable capacity multiplied by a quota
  percentage.

Official usage, observed tokens, and token equivalents cover different scopes.
They are shown independently and are never added together.

## Highlights

- local-only collector on `127.0.0.1`, with independently failing adapters;
- real quota windows, reset times, balances, and exact API usage where available;
- provider visibility controls, warning thresholds, risk states, keyboard
  shortcuts, and copyable sanitized summaries;
- real local provider artwork, with a text fallback for custom providers;
- dedicated `/display` view for 480×320 and 800×480 always-on screens, with
  automatic paging, fullscreen, and Screen Wake Lock controls;
- native macOS menu bar summary for up to three providers, with every quota
  window, freshness warnings, and available per-model tokens in its popover;
- optional multi-host Cloudflare deployment with a strict snapshot allowlist.

## Included adapters

| Adapter | Quota source | Token methods | Credential boundary |
| --- | --- | --- | --- |
| OpenAI Codex | Existing Codex CLI OAuth session | Optional quota conversion and local `token_count` events | Reads CLI-owned files; never writes credentials |
| Kimi Code | API key or unexpired CLI session | Optional quota conversion | Optional key stored outside the repository with mode `0600` |
| OpenAI API | Documented Organization Usage API | Exact seven-day model tokens and request counts | Admin key stays in the local collector |
| OpenRouter | Documented current-key endpoint | Key spend, limit, and reset period | API key stays in the local collector |
| DeepSeek API | Documented user-balance endpoint | Balance only; no invented quota window | API key stays in the local collector |
| GitHub Copilot | Documented user AI Credits billing endpoint | Monthly AI Credits, optionally compared with a configured limit | Fine-grained token with `Plan: read` stays local |
| Custom snapshot | Any collector that emits the normalized schema | Any normalized method | Hosted ingest accepts only a strict field allowlist |

The Codex and Kimi quota endpoints are used by official clients but are not
documented as stable third-party APIs. The remaining direct adapters use
documented provider APIs. See [Security and limitations](docs/security.md).

## Quick start

Requirements: macOS or Linux and Node.js 22.13 or newer.

```bash
git clone https://github.com/0xBigotry7/ai-usage-dashboard.git
cd ai-usage-dashboard
npm ci
npm run local
```

Open <http://localhost:3000>. The collector listens only on
`127.0.0.1:4317`.

For a second monitor or a small HDMI display, open
<http://localhost:3000/display>. See the
[external display guide](docs/external-display.md) for kiosk setup.

Codex is detected from an existing CLI login. Kimi is optional:

```bash
npm run configure:kimi
```

The prompt does not echo the key. It is stored in `~/.usage-hub/env`, not in
the repository or browser.

Optional documented API adapters can be configured one at a time:

```bash
npm run configure:provider -- openai-api
npm run configure:provider -- openrouter
npm run configure:provider -- deepseek
npm run configure:provider -- github-copilot
```

An optional adapter appears only after its required local configuration exists.

## Token and usage methods

### Official API usage

OpenAI Organization Usage returns exact token and request totals grouped by
model. GitHub reports AI Credits, OpenRouter reports key spend, and DeepSeek
reports account balance. These values are not converted into subscription quota.

### Quota conversion

```text
estimated tokens = weekly used percentage × configured weekly capacity
```

There is no built-in capacity. The converted token estimate is produced only
after you set a calibration value such as
`USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY`; without one, the dashboard shows the
quota percentage alone. The capacity is your own calibration value, not an
official token limit published by the provider.

### Local CLI logs

The Codex adapter scans only `token_count` and model metadata events from local
JSONL session files. It sums deduplicated cumulative-counter deltas over the
current subscription window, aligned with the weekly quota cycle embedded in
the log events (falling back to the past seven days when no window is found).
Resumed or forked sessions are not double-counted. The result reports
`totalTokens`, which includes cached input reads, with the cached-read portion
broken out as `cachedInputTokens`. Prompt and response content is neither
exported nor uploaded. This method covers this machine only and can miss usage
from other devices or deleted logs.

Disable it with:

```bash
USAGE_HUB_CODEX_LOG_ESTIMATE=off npm run local
```

These methods answer different questions. They are displayed side by side with
distinct labels and are never summed or treated as comparable totals.

## macOS menu bar

The native companion reads the same loopback collector every 60 seconds. It
shows the primary quota percentage for up to three providers directly in the
menu bar. Provider health is stated inline: `旧` marks a stale snapshot and
`异常` marks a provider error, instead of using an ambiguous trailing
exclamation mark. Its popover shows every returned quota window and reset time,
balances, freshness, and up to three available model token totals per provider.
Official API totals, local-log observations, and quota-based estimates retain
their distinct labels. It does not read or store provider credentials.

### Build and use it locally

Building from source is the currently supported installation path. The
repository does not publish a notarized `.app`, DMG, or Homebrew cask.
Requirements are macOS 14 or newer, Node.js 22.13 or newer, and Xcode 16 or
newer with Swift 6.

First start the dashboard and loopback collector, and keep this terminal open:

```bash
npm ci
npm run local
```

In a second terminal, build and launch the menu-bar app:

```bash
npm run build:menubar
open "dist/AI Usage Dashboard Menu Bar.app"
```

The app is only a local display client; it expects the collector to remain
available at `127.0.0.1:4317`. For Swift development without assembling the
standalone bundle, use `npm run menubar`. After testing the build, drag the
`.app` from `dist/` to `/Applications` before enabling **Launch at Login**.

The local build is ad-hoc signed. It is suitable for development and personal
installation on the machine that built it, but it is not a notarized public
release. Do not redistribute it as though Apple had verified the publisher.
The manual **macOS package proof** workflow builds the same credential-free
artifact and publishes it only as a short-lived workflow artifact. See
[macOS packaging, signing, and Homebrew](docs/macos-release.md) before
distributing a release.

The menu bar now keeps a three-provider summary visible, calculates a projected
period-end pace only when a real duration and reset time are available, and can
send deduplicated 70%, 80%, or 90% quota alerts after the user opts in. The
pace and notification behavior was adapted from ideas in CodexBar; exact
upstream sources and reuse decisions are recorded in the
[CodexBar implementation review](docs/attribution.md#codexbar-implementation-review).

## External always-on display

`/display` is a separate information surface, not a compressed copy of the
dashboard. It is designed to fit without scrolling at 480×320 and 800×480,
shows three or four providers per page depending on width, and changes pages
automatically every eight seconds. The view includes manual fullscreen and
Screen Wake Lock controls; browser and operating-system support still applies.

See [External display and kiosk setup](docs/external-display.md).

## Optional hosted dashboard

The app can be deployed to Cloudflare Workers with D1. Collectors push
sanitized snapshots through a bearer-protected ingest endpoint; viewers use a
separate code that becomes a secure session cookie.

The hosted schema accepts numeric usage, reset times, display metadata, and
token estimates. It rejects unknown provider fields and never accepts OAuth
tokens, API keys, hostnames, file paths, prompts, completions, or raw logs.

See [Configuration and deployment](docs/configuration.md).

## Adding providers

Local adapters are registered in `collector/providers/index.mjs`. A provider
only needs to return the normalized provider object; the dashboard, history,
cloud sanitizer, menu bar, and external display remain provider-agnostic.

Read [Provider development](docs/provider-development.md) before submitting an
adapter. New providers should expose a trustworthy capability that the current
schema cannot already represent; breadth alone is not a goal. Machine-specific
or private collectors should stay outside the public repository and send only
the normalized snapshot.

## Project map

```text
app/                  Dashboard and hosted API routes
app/display/          Always-on external display route
collector/providers/  Local provider adapters and registry
collector/            History and token estimators
lib/                  Snapshot sanitization and viewer authentication
db/ + drizzle/        D1 schema and migration
worker/               Cloudflare Worker entry point
scripts/              Local configuration helpers
apps/macos-menu-bar/  Native macOS menu bar companion
tests/                Normalization, estimation, security, and render tests
```

## Documentation

- [Architecture and data flow](docs/architecture.md)
- [External display and kiosk setup](docs/external-display.md)
- [macOS packaging, signing, and Homebrew](docs/macos-release.md)
- [Configuration and Cloudflare deployment](docs/configuration.md)
- [Provider development](docs/provider-development.md)
- [Security model and limitations](docs/security.md)
- [Attribution and provenance](docs/attribution.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Roadmap](docs/roadmap.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## Status

This is an early open-source project. Missing quota windows remain explicit;
reset times are estimated only after history shows a real percentage drop, and
the UI labels that time as estimated.

Bundled provider artwork comes from
[`@lobehub/icons-static-svg` 1.94.0](https://github.com/lobehub/lobe-icons)
under the MIT license. The artwork is stored locally; the dashboard does not
contact an icon CDN. Product names, logos, and trademarks belong to their
respective owners. See [Third-party notices](THIRD_PARTY_NOTICES.md).

AI Usage Dashboard is not affiliated with OpenAI, Moonshot AI, Cloudflare,
CodexBar, Lobe Icons, or ccusage.

## License

[MIT](LICENSE)
