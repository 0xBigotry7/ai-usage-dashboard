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
Each provider keeps those methods separate. The cross-provider overview has
three independent layers: tokens recorded today, tokens recorded in the current
subscription cycle, and quota-based conversion. The layers are never added
together, and quota conversion is never presented as observed usage.

## Highlights

- local-only collector on `127.0.0.1`, with independently failing adapters;
- real quota windows, reset times, balances, and exact API usage where available;
- provider visibility controls, warning thresholds, risk states, keyboard
  shortcuts, and copyable sanitized summaries;
- real local provider artwork, with a text fallback for custom providers;
- dedicated `/display` view for 480×320 and 800×480 always-on screens, with
  automatic paging, fullscreen, and Screen Wake Lock controls;
- native macOS menu bar summary for up to three providers, with every quota
  window, freshness warnings, today's observed input/output total, and
  available per-model tokens in its popover;
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
after you set a calibration value; without one, the dashboard shows the quota
percentage alone:

```bash
npm run configure:capacity -- kimi 10000000
```

Use `codex` instead of `kimi` to calibrate Codex, or pass `clear` instead of a
number to remove a calibration. The capacity is your own display assumption,
not an official token limit published by the provider.

### Local CLI logs

The Codex adapter scans only `token_count`, model metadata, and rollout
relationship fields from local JSONL session files. It reports two independent
observed ranges: the current local calendar day and the current subscription
cycle. The cycle is aligned with the weekly quota window embedded in log events,
falling back to the trailing seven days.

Counters are accumulated as deltas. When a fork or resumed rollout replays an
ancestor's cumulative history with new timestamps, the matching ancestor prefix
is removed before the first new turn is counted. This prevents child-agent work
from multiplying parent usage while retaining novel work from parallel
children.

`totalTokens = inputTokens + outputTokens`. Cached input is already included in
`inputTokens`, and reasoning output is already included in `outputTokens`; both
are shown as subsets and are not added again. Prompt and response content is
neither exported nor uploaded. This method covers this machine only and can
miss usage from other devices, deleted logs, or events the CLI never wrote.

Disable it with:

```bash
USAGE_HUB_CODEX_LOG_ESTIMATE=off npm run local
```

These methods answer different questions and remain side by side with distinct
labels on each provider. The overview keeps “today recorded,” “subscription
cycle recorded,” and “quota conversion” separate. A provider without an
observed token source is shown as unavailable in the recorded layer rather than
receiving a fabricated zero.

## macOS menu bar

The packaged native companion starts its bundled loopback collector and reads
it every 60 seconds. Normal provider API polls run at most once every five
minutes; transient failures get one short retry and then retain the last-good
snapshot during backoff. Manual refresh may make one immediate recovery attempt
after an authentication or missing-configuration result, but cannot bypass the
cooldown for ready data or transient failures. It shows the primary quota
percentage for up to three providers directly in the menu bar. Provider health
is stated inline: `旧` marks a stale snapshot and `异常` marks a provider error,
instead of using an ambiguous trailing exclamation mark. Its popover shows every
returned quota window and reset time, balances, freshness, today's observed
input + output total when available, and up to three model token totals per
provider. Official API totals, local-log observations, and quota-based estimates
retain their distinct labels. It does not read or store provider credentials.

### Build and use it locally

Building from source is the currently supported installation path. The
repository does not publish a notarized `.app`, DMG, or Homebrew cask.
Requirements are macOS 14 or newer, Node.js 22.13 or newer, and Xcode 16 or
newer with Swift 6.

Install dependencies. Start the web dashboard separately only if you want the
browser view:

```bash
npm ci
npm run local
```

Build and launch the menu-bar app:

```bash
npm run build:menubar
open "dist/AI Usage Dashboard Menu Bar.app"
```

The packaged app carries and starts the collector itself, while credentials
remain in `~/.usage-hub/env`. `swift run` does not have an app bundle, so Swift
development still requires `npm run collector` in another terminal. To make
the Dashboard button open a hosted installation, build with
`USAGE_HUB_DASHBOARD_URL=https://example.com npm run build:menubar`. After
testing the build, drag the
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
