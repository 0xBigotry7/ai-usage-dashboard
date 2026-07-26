# Attribution and provenance

This project documents both direct dependencies and product inspiration.

## Product and architecture inspiration

| Project | Relationship | Code copied? | License |
| --- | --- | --- | --- |
| [CodexBar](https://github.com/steipete/CodexBar) | Interface and architecture inspiration; pace projection and quota-alert state behavior adapted to the normalized provider schema | Adapted behavior; no vendored source file | MIT |
| [ccusage](https://github.com/ryoppippi/ccusage) | Demonstrates a broad, provider-neutral approach to local CLI usage analysis; a future optional adapter is on the roadmap | No | MIT |
| [Kimi Code](https://github.com/MoonshotAI/kimi-code) | Public CLI structure and behavior informed Kimi compatibility | No copied implementation | MIT |
| [vinext](https://github.com/cloudflare/vinext) | Runtime used to build the Next.js app for Cloudflare | Direct dependency | MIT |
| OpenAI Sites starter | Supplied initial full-stack scaffolding and packaging conventions | Scaffold adapted | Dependency licenses apply |

The Codex JSONL estimator in this repository was implemented specifically for
this project. It reads cumulative `token_count` events and does not vendor
CodexBar or ccusage parsing code. The menu-bar pace projection and quota-alert
state behavior are small, schema-specific adaptations of ideas in the
MIT-licensed CodexBar sources identified below; no complete CodexBar source
file or provider parser is vendored.

## CodexBar implementation review

The review below is pinned to
[CodexBar commit `cc8da27`](https://github.com/steipete/CodexBar/tree/cc8da27cec92029a6435bfee4a703a719290234e)
from 2026-07-20. Source files in that repository are MIT-licensed, copyright
2026 Peter Steinberger. “Adapt” means reimplement against this project's
smaller normalized schema.

CodexBar's reviewed implementation uses variable-length AppKit `NSStatusItem`
instances and an `NSMenu` containing SwiftUI-hosted cards. It is not a single
fixed-width `MenuBarExtra` popover. Its menu starts from a 310-point baseline,
measures native rows at runtime, and caches fitted card heights by width, text
scale, and content revision. That distinction matters: adopting the full
controller would be an architecture change, while adopting content-aware
measurement can remain a focused improvement.

| Area | CodexBar source | Reuse decision for AI Usage Dashboard |
| --- | --- | --- |
| Status item and menu sizing | [`StatusItemController.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBar/StatusItemController.swift), [`MenuBarStatusItemPlacementPreflight.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBar/MenuBarStatusItemPlacementPreflight.swift), [`StatusItemController+MenuWidthCache.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBar/StatusItemController%2BMenuWidthCache.swift), and [`StatusItemController+MenuCardHeightCache.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBar/StatusItemController%2BMenuCardHeightCache.swift) | **Adapted in the macOS companion.** It now uses a native variable-width `NSStatusItem`, a stable autosave name, and a first-launch preferred position so macOS 26 does not park a crowded item under the camera housing. User Command-drag placement remains authoritative. CodexBar's full controller, menu-switcher, measurement caches, and multi-item recovery machinery were not copied. |
| Provider navigation and rows | [`StatusItemController+SwitcherViews.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBar/StatusItemController%2BSwitcherViews.swift), [`MenuCardView.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBar/MenuCardView.swift), and [`UsageMenuCardLayout.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBar/UsageMenuCardLayout.swift) | Reuse the information hierarchy: provider identity, independent window rows, reset/freshness detail, and a compact quota cue. Our current vertical provider cards are simpler and should remain data-driven; provider-specific branches and CodexBar's multi-row switcher are not suitable for direct copying. |
| Pace and burn-down | [`UsagePace.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBarCore/UsagePace.swift) and [`BurnDownWidgetViews.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBarWidget/BurnDownWidgetViews.swift) | **Adapted in the macOS companion.** The smaller implementation projects period-end use and exhaustion time from elapsed window time and observed usage. It requires a real reset time and duration, suppresses early-window forecasts, and labels the result as projected. The WidgetKit view and provider-specific historical backfill were not copied. |
| Notifications | [`AppNotifications.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBar/AppNotifications.swift), [`SessionQuotaNotifications.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBar/SessionQuotaNotifications.swift), and [`PredictivePaceWarnings.swift`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Sources/CodexBar/PredictivePaceWarnings.swift) | **Adapted in the macOS companion.** Alerts are scoped by provider, window, threshold, and reset cycle; a recovered window clears its fired state. Permission is requested only after the user enables alerts. CodexBar's startup prompt and provider-specific ownership and recovery rules were not copied. |
| Signing and notarization | [`Scripts/sign-and-notarize.sh`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/Scripts/sign-and-notarize.sh) and [`docs/RELEASING.md`](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/docs/RELEASING.md) | Adapt the ordering and release gates: sign nested code before the app, use hardened runtime and a timestamp, submit with `notarytool`, staple, validate with `codesign` and Gatekeeper, package with `ditto`, publish checksums, then test the downloaded artifact. Do not copy identities, credentials, Sparkle keys, or CodexBar-specific helper and widget steps. |
| Homebrew | [CodexBar release workflow](https://github.com/steipete/CodexBar/blob/cc8da27cec92029a6435bfee4a703a719290234e/.github/workflows/release-cli.yml) and its separate [tap cask](https://github.com/steipete/homebrew-tap/blob/986e7d59be28c2b59ea1f5fdfb5ce3a7c3d07bd8/Casks/codexbar.rb) | Follow the release-asset → checksum → tap-update sequence, but write an original cask from the official Homebrew Cask DSL. The tap repository had no license file at the reviewed commit, so its cask source is not copied. |

The adaptations above first shipped in version 0.8.0. The pinned commit,
copyright, and MIT permission text are preserved in
[Third-party notices](../THIRD_PARTY_NOTICES.md). Future ports must name their
source file and commit and add focused tests for the behavior being adopted.

## Bundled provider artwork

The SVG files in `public/brands/` were sourced from
[`@lobehub/icons-static-svg` 1.94.0](https://www.npmjs.com/package/@lobehub/icons-static-svg),
part of [Lobe Icons](https://github.com/lobehub/lobe-icons), under the MIT
license. They are copied into this repository and application bundles so the
clients do not make third-party icon requests.

The current local asset set contains seven icons: Claude, Codex, OpenAI, Kimi,
DeepSeek, OpenRouter, and GitHub Copilot. Lobe Icons supplies the artwork but
does not grant rights to the represented product names or trademarks. Those
remain the property of their respective owners. See
[Third-party notices](../THIRD_PARTY_NOTICES.md).

## Direct dependencies

The lockfile is the authoritative version record.

| Package | Role | License |
| --- | --- | --- |
| [Next.js](https://github.com/vercel/next.js) | Application framework | MIT |
| [React](https://github.com/facebook/react) | UI runtime | MIT |
| [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm) | D1 schema and queries | Apache-2.0 |
| [Cloudflare Workers SDK](https://github.com/cloudflare/workers-sdk) | Runtime plugin and deployment tooling | MIT OR Apache-2.0 |
| [Vite](https://github.com/vitejs/vite) | Build tool | MIT |
| [Lobe Icons](https://github.com/lobehub/lobe-icons) | Source of bundled provider SVG artwork | MIT |

## Provider references

- [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Kimi Code repository](https://github.com/MoonshotAI/kimi-code)
- [OpenAI Organization Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage)
- [OpenRouter current API key usage](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
- [DeepSeek user balance API](https://api-docs.deepseek.com/api/get-user-balance/)
- [GitHub billing AI credit usage](https://docs.github.com/en/rest/billing/usage)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)

## Trademark and affiliation

AI Usage Dashboard is not affiliated with, endorsed by, or sponsored by OpenAI,
Moonshot AI, Cloudflare, CodexBar, Lobe Icons, or ccusage. Product names, model
names, logos, and trademarks belong to their respective owners. Their inclusion
identifies compatible services and does not imply endorsement.
