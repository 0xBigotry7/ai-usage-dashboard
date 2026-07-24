# AI Usage Dashboard

[![CI](https://github.com/0xBigotry7/ai-usage-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/0xBigotry7/ai-usage-dashboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-5FA04E.svg)](package.json)

A local-first, extensible dashboard for AI quota windows and token estimates.
It is designed for a desktop browser or a small always-on display.

[中文说明](README.zh-CN.md)

## Why this project exists

AI coding tools expose usage in different places and formats. This project
normalizes those signals into one small dashboard without sending provider
credentials or raw conversations to the browser.

It deliberately separates three concepts:

- **quota**: the percentage and reset time returned by a provider;
- **observed tokens**: token counters found in local CLI session logs;
- **token equivalent**: a configurable capacity multiplied by a quota
  percentage.

Observed tokens and token equivalents are independent estimates. They are never
added together.

## Included adapters

| Adapter | Quota source | Token methods | Credential boundary |
| --- | --- | --- | --- |
| OpenAI Codex | Existing Codex CLI OAuth session | Quota conversion and local `token_count` events | Reads CLI-owned files; never writes credentials |
| Kimi Code | API key or unexpired CLI session | Quota conversion | Optional key stored outside the repository with mode `0600` |
| Custom snapshot | Any collector that emits the normalized schema | Either method | Hosted ingest accepts only a strict field allowlist |

The included direct quota endpoints are used by official clients but are not
documented as stable third-party APIs. See [Security and limitations](docs/security.md).

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

## Two token-estimation methods

### 1. Quota conversion

```text
estimated tokens = weekly used percentage × configured weekly capacity
```

This is useful for comparing overall subscription pressure across devices, but
the capacity is a calibration value rather than an official token limit.

### 2. Local CLI logs

The Codex adapter scans only `token_count` and model metadata events from local
JSONL session files. It sums cumulative-counter deltas over the past seven days.
Prompt and response content is neither exported nor uploaded. This method can
miss usage from other devices or deleted logs.

Disable it with:

```bash
USAGE_HUB_CODEX_LOG_ESTIMATE=off npm run local
```

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
