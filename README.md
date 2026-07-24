# AI Usage Dashboard

[![CI](https://github.com/0xBigotry7/ai-usage-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/0xBigotry7/ai-usage-dashboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-5FA04E.svg)](package.json)

A local-first, extensible dashboard for AI quota windows, official API usage,
balances, and token estimates. It includes a polished desktop/small-screen UI
and a native macOS menu bar companion.

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
- compact mode for narrow always-on displays;
- native macOS menu bar preview, refreshed every 60 seconds;
- optional multi-host Cloudflare deployment with a strict snapshot allowlist.

## Included adapters

| Adapter | Quota source | Token methods | Credential boundary |
| --- | --- | --- | --- |
| OpenAI Codex | Existing Codex CLI OAuth session | Quota conversion and local `token_count` events | Reads CLI-owned files; never writes credentials |
| Kimi Code | API key or unexpired CLI session | Quota conversion | Optional key stored outside the repository with mode `0600` |
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

This is useful for comparing overall subscription pressure across devices, but
the capacity is a calibration value rather than an official token limit.

### Local CLI logs

The Codex adapter scans only `token_count` and model metadata events from local
JSONL session files. It sums cumulative-counter deltas over the past seven days.
Prompt and response content is neither exported nor uploaded. This method can
miss usage from other devices or deleted logs.

Disable it with:

```bash
USAGE_HUB_CODEX_LOG_ESTIMATE=off npm run local
```

## macOS menu bar

The native companion reads the same loopback collector every 60 seconds. It
shows the highest current usage in the menu bar and provider details in a
compact popover. It does not read or store provider credentials.

```bash
npm run build:menubar
open "dist/AI Usage Dashboard Menu Bar.app"
```

For development, use `npm run menubar`. macOS 14 or newer is required.

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
cloud sanitizer, and compact display remain provider-agnostic.

Read [Provider development](docs/provider-development.md) before submitting an
adapter. Machine-specific or private collectors should stay outside the public
repository and send only the normalized snapshot.

## Project map

```text
app/                  Dashboard and hosted API routes
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
- [Configuration and Cloudflare deployment](docs/configuration.md)
- [Provider development](docs/provider-development.md)
- [Security model and limitations](docs/security.md)
- [Attribution and provenance](docs/attribution.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)

## Status

This is an early open-source project. Missing quota windows remain explicit;
reset times are estimated only after history shows a real percentage drop, and
the UI labels that time as estimated.

AI Usage Dashboard is not affiliated with OpenAI, Moonshot AI, Cloudflare,
CodexBar, or ccusage. Product names and trademarks belong to their owners.

## License

[MIT](LICENSE)
