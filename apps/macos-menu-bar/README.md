# macOS menu bar

The menu bar companion reads the local collector at
`http://127.0.0.1:4317/api/usage` every 60 seconds. It stores no provider
credentials and does not query provider APIs directly.

The menu bar label shows the primary quota percentage for up to three providers,
for example `CX 74% · KM 48% · CL 13%`. Stale data is marked on the affected
provider with `旧`, while a provider error is marked `异常`; there is no
ambiguous global exclamation mark. Local providers use a ten-minute freshness
threshold. Claude uses 45 minutes because its remote collector is intentionally
polled less often.
On first launch the app gives its native `NSStatusItem` a stable saved position
so a crowded macOS 26 menu bar does not park it underneath a MacBook camera
housing. You can still Command-drag the label to any position you prefer.

Open the popover to see:

- every quota window and reset time returned by each provider;
- projected period-end usage and an estimated exhaustion time when reset and
  duration data make a pace calculation possible;
- provider-level data freshness and balances;
- up to three model token totals, clearly marked as official API usage, local
  session-log estimates, or quota-percentage estimates;
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
login-item registration can work for local builds. The packaged app starts the
collector itself; `npm run menubar` development still needs `npm run collector`
in another terminal. Keep the app in
`/Applications` before enabling **Launch at Login**. macOS may ask you to confirm
it under **System Settings › General › Login Items**.

The application requires macOS 14 or newer.

If the label is hidden, open **System Settings › Menu Bar › Allow in the Menu
Bar** and enable **AI Usage Dashboard Menu Bar**.
