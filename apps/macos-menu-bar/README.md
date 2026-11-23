# macOS dashboard and desktop widgets

Open the app from Applications to change settings. The **Menu bar** switch is
off by default. **Widget updates** independently controls whether a placed
widget can show quota readings. The app does not create any floating desktop
windows.

## Add a desktop widget

1. Install the built app in Applications and open it once.
2. Control-click the desktop, choose **Edit Widgets**, and search for
   **AI Usage Dashboard**.
3. Drag a small, medium, or large widget onto the desktop. Use its system
   context menu to resize or remove it.

Small shows the connected quota pool with the least remaining allowance,
prioritizing fresh readings, and its reset time when available. Medium and
large show up to three and six pools. Click a pool to open the native details,
including its product readings where available. WidgetKit schedules updates
and may defer the requested 15-minute refresh. A stopped collector produces
an offline state. Switching **Widget updates** off hides readings on the
next system reload. Placement and removal belong to macOS.

## Choose data sources

Open **Connections** to set each source to **Automatic**, **On**, or **Off**.
Automatic follows existing collector detection and environment settings. On
enables the selected adapter and displays its supported connection fields.
Select a local CLI, a client profile or snapshot, or enter a provider API
key as indicated. Sign in using the corresponding provider app or CLI first
when its adapter requires a signed-in session. This dashboard does not
perform those sign-ins. Off skips the adapter.

Gemini and Muse launchers are independent opt-ins for installed apps.
A Muse manual snapshot is a separate source. The optional Claude per-model
reader requires a signed-in account that reports that limit. Grok Build and
Bot share a card only when their unified weekly window matches, and Cursor
keeps its own billing cycle.

Preferences, including any entered API keys, stay in the owner's local
`~/.usage-hub/desktop-connections.json` with mode 0600. API keys are stored
in that file in plaintext. There is no web API for writing connection
settings. The sandboxed widget reads only a minimal local quota summary
from `http://127.0.0.1:4317/api/widget` and receives no credentials.

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
The demo uses illustrative values.

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
