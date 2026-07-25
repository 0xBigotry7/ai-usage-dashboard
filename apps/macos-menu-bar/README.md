# macOS menu bar

The menu bar companion reads the local collector at
`http://127.0.0.1:4317/api/usage` every 60 seconds. It stores no provider
credentials and does not query provider APIs directly.

The menu bar label shows the primary quota percentage for up to three providers,
for example `CX 74% · KM 48% · CL 13%`. A trailing `!` means that the collector
is unavailable or at least one provider update is more than five minutes old.

Open the popover to see:

- every quota window and reset time returned by each provider;
- provider-level data freshness and balances;
- up to three model token totals, clearly marked as official API usage, local
  session-log estimates, or quota-percentage estimates;
- real provider artwork loaded from `public/brands`;
- a native **Launch at Login** switch powered by `SMAppService`.

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

The build reads its version from the root `package.json`, copies SVG provider
logos into the application bundle, and applies an ad-hoc signature so native
login-item registration can work for local builds. Keep the app in
`/Applications` before enabling **Launch at Login**. macOS may ask you to confirm
it under **System Settings › General › Login Items**.

The application requires macOS 14 or newer.
