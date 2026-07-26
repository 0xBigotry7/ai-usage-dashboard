# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.1] - 2026-07-26

### Added

- Codex session logs now expose separate local-day and subscription-cycle
  records with input, output, cached-input, reasoning-output, session, and
  per-model breakdowns.
- The dashboard presents three non-additive Token layers: today recorded,
  subscription-cycle recorded, and calibrated quota conversion.
- The macOS popover shows today's observed total and its input/output
  composition before the model breakdown.

### Changed

- Observed Codex usage is preferred over a quota-capacity conversion in the
  dashboard and macOS companion. The collector remains the canonical source of
  the preferred method.
- OpenAI Organization Usage retains input and output totals for each model and
  labels its range as account-level rolling seven-day usage.
- The hosted snapshot allowlist preserves token period, scope, and optional
  component fields without inventing zero-valued breakdowns for older clients.

### Fixed

- Forked or resumed Codex rollouts that replay ancestor counters with rewritten
  timestamps no longer multiply the parent's usage. The final replay state is
  retained as a zero-contribution delta baseline so gaps before the first novel
  child observation are not lost.
- Sibling rollouts sharing a missing ancestor deduplicate their exact common
  prefix, and incomplete ancestry is marked as an estimate.
- Cached input and reasoning output are emitted only when they satisfy their
  input/output subset invariants; neither is added to the total again.
- Reporting windows now exclude token events after the requested cutoff.

## [0.8.0] - 2026-07-26

### Added

- Native macOS menu bar companion: three-provider summary in the status item,
  complete quota-window popover, explicit stale (`旧`) and error (`异常`)
  states, pace projections when a real window duration and reset time exist,
  and opt-in, cycle-deduplicated 70% / 80% / 90% quota alerts.
- Packaged menu bar builds include and start the loopback collector, while
  `USAGE_HUB_DASHBOARD_URL` can set the Dashboard button's destination at
  build time.
- `configure:capacity` safely writes a local Codex or Kimi token calibration
  without requiring users to edit the credentials file by hand.
- Session-log token estimates now report deduplicated `totalTokens` with the
  cached-input-read portion broken out as `cachedInputTokens`.
- The collector validates the request `Host` header and only serves loopback
  hosts (`127.0.0.1`, `localhost`, `[::1]`).
- The hosted history API response includes a `truncated` boolean, set when the
  10,000-row response limit cuts off older points in the requested range.
- Collector tuning variables `USAGE_HUB_HOST`, `USAGE_HUB_PORT`,
  `USAGE_HUB_POLL_INTERVAL_MS`, `USAGE_HUB_DB`, and `USAGE_HUB_ENV_FILE`.

### Changed

- `USAGE_HUB_CODEX_WEEKLY_TOKEN_CAPACITY` and
  `USAGE_HUB_KIMI_WEEKLY_TOKEN_CAPACITY` no longer have a default. Without a
  user-calibrated value, no quota-converted token estimate is produced and only
  the quota percentage is shown. The capacity is a user calibration value, not
  an official provider limit.
- Session-log estimates align the counting window with the subscription quota
  cycle embedded in log events (`rate_limits.secondary`), falling back to the
  past seven days when no window is found.
- The cross-provider Token headline selects one preferred method per provider,
  includes quota conversion only when a capacity was explicitly calibrated,
  lets an explicit subscription-wide calibration take precedence over
  machine-local logs, and marks inferred or mixed-scope totals as estimates.
- The collector starts its loopback listener before slow provider refreshes,
  and the packaged menu app retries briefly during cold start.
- Both the hosted ingest route and the local history store retain only the
  most recent 31 days of samples; older rows are pruned automatically.
- The collector version string is read from `package.json` instead of a
  hardcoded constant.

### Fixed

- Resumed or forked Codex sessions no longer double-count tokens inherited
  from the parent session's cumulative counter; lost events between samples no
  longer undercount because counter deltas are preferred over per-turn usage.
- Repeated cumulative `token_count` events with an unchanged counter no longer
  count the same turn twice, and an expired quota window can no longer pin the
  session-log estimate to the previous subscription cycle.
- OpenAI Organization Usage no longer double-counts audio tokens:
  `input_tokens` already includes the audio/image subsets, so only input and
  output tokens are summed.
- An adapter that throws unexpectedly no longer takes down the whole
  collection cycle; it is reported as an error provider while the other
  adapters continue.
- The GitHub Copilot adapter's `X-GitHub-Api-Version` header is corrected to
  `2022-11-28`; the previous value was not a valid GitHub API version.
- The hosted ingest route clamps self-reported future timestamps to the
  receipt time, so a pusher with a skewed clock cannot write history rows
  dated in the future.

[Unreleased]: https://github.com/0xBigotry7/ai-usage-dashboard/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/0xBigotry7/ai-usage-dashboard/releases/tag/v0.8.1
[0.8.0]: https://github.com/0xBigotry7/ai-usage-dashboard/releases/tag/v0.8.0
