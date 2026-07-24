# macOS menu bar

The menu bar companion reads the local collector at
`http://127.0.0.1:4317/api/usage` every 60 seconds. It stores no provider
credentials and does not query provider APIs directly.

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

The application requires macOS 14 or newer.
