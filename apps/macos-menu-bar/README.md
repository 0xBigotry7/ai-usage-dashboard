# macOS menu bar

The menu bar companion reads the local collector at
`http://127.0.0.1:4317/api/usage` every 60 seconds. It stores no provider
credentials and does not query provider APIs directly.

The menu bar shows original-color provider icons and primary quota percentages
in one horizontal row (up to six providers). Stale values get `*` and an orange
label; failed providers show a red dash, not a fabricated zero. Hover for full
provider names and status. Local providers use a ten-minute freshness threshold;
Claude uses 45 minutes. This is a presentation threshold, not a provider polling
interval. Collection behavior has not changed with the new interface.
On first launch the app gives its native `NSStatusItem` a stable saved position
so a crowded macOS 26 menu bar does not park it underneath a MacBook camera
housing. You can still Command-drag the label to any position you prefer.

The expanded panel is a 640-point-wide, 3×2 card overview. All six cards and
settings fit together without a main scrolling list. Each card shows the
primary usage metric, reset time, and freshness. Where supplied, it also shows
a secondary five-hour window or a correctly labeled token total. Token-only
and balance-only adapters display those metrics rather than inventing quota
percentages. More than six providers use Previous/Next pages, in collector order.

Click a card for the secondary detail popover, which preserves:

- every quota window and reset time returned by each provider;
- projected period-end usage and an estimated exhaustion time when reset and
  duration data make a pace calculation possible;
- provider-level data freshness and balances;
- today's observed input + output total when the collector supplies it;
- up to three model token totals, marked with their period and as official API
  usage, local session-log observations, or quota-percentage estimates;
- real provider artwork loaded from `public/brands`, including upstream color
  variants for Codex, Kimi, and Claude;
- optional 70%, 80%, or 90% quota notifications (80% by default), deduplicated
  once per provider window and quota cycle;
- a native **Launch at Login** switch powered by `SMAppService`.

Notifications are disabled until the user turns on **Quota alerts**. Stale
provider snapshots never trigger an alert, and a window without a reset time is
eligible again only after its usage falls below the selected threshold.

Run from source:

```bash
npm run local
npm run menubar
```

Build a standalone `.app`:

```bash
npm run build:menubar
open "dist/AI Usage Dashboard Menu Bar.app"
```

The build reads its version from the root `package.json`, bundles the loopback
collector and SVG provider logos, and applies an ad-hoc signature so native
login-item registration can work for local builds. The packaged app bundles the
collector's JavaScript but not a Node.js runtime: it starts the collector with
your installed Node.js 22.13 or newer, searched in `USAGE_HUB_NODE` (if set),
the Homebrew and `/usr/local` paths, nvm, mise, and asdf installs, and finally
the login shell's `PATH`. If none qualifies, the menu bar item shows `AI ⚠` and
the popover explains what to install; collector output is logged to
`~/Library/Logs/AIUsageDashboard/collector.log`. `npm run menubar` development
still needs `npm run collector` in another terminal. Keep the app in
`/Applications` before enabling **Launch at Login**. macOS may ask you to confirm
it under **System Settings › General › Login Items**.

The packaged app probes only its loopback `/healthz` endpoint every 15 seconds.
If its owned collector exits, it restarts it with bounded backoff; a healthy
collector already listening on port 4317 is adopted instead of duplicated.
Provider request cadence and backoff remain controlled by the collector itself.

The application requires macOS 14 or newer.

## Offline demo and documentation screenshots

```bash
npm run menubar -- --demo
node scripts/capture-menu-bar-preview.mjs
```

`--demo` is handled before collector startup and before session or API access.
It displays six synthetic providers in a dedicated preview window and disables
account settings. The capture script renders only the app's own demo content
to `docs/images/menu-bar-overview.png`; it does not capture the desktop.
Numbers are illustrative, not provider plan limits. In particular, this does
not add an official Claude quota endpoint or new proprietary adapters.

The public build contains no preconfigured remote host, SSH command, private
snapshot path, account cookie, or credential. Custom snapshot integration stays
an explicit user configuration; the UI does not require a remote machine.

Standalone presentation checks (no XCTest dependency):

```bash
swiftc apps/macos-menu-bar/Sources/UsageMenuBar/MenuPresentation.swift \
  apps/macos-menu-bar/Sources/UsageMenuBar/DemoData.swift \
  tests/menu-presentation-check.swift -o /tmp/menu-presentation-check
/tmp/menu-presentation-check
```

If the label is hidden, open **System Settings › Menu Bar › Allow in the Menu
Bar** and enable **AI Usage Dashboard Menu Bar**.
