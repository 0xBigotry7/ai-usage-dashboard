# External display and kiosk setup

The `/display` route is a purpose-built, glanceable surface for an always-on
screen. It is not the responsive dashboard with controls hidden. The layout is
designed to fit without scrolling at 480×320 and 800×480.

## What it shows

- three providers per page below 680 pixels, or four at larger widths;
- every available quota window, percentage, and reset time;
- balance or model-token information when a provider supplies it;
- provider freshness and collector connectivity;
- automatic page changes every eight seconds when more providers are present.

The header offers **Always on**, **Fullscreen**, **Refresh**, and **Dashboard**
controls. “Always on” requests the browser
[Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API).
Browsers can release a wake lock when the tab is hidden, the battery is low, or
the operating system overrides it. Kiosk mode alone does not disable operating
system sleep settings.

## Local display

Start the collector and web app on the computer that owns the provider
credentials:

```bash
npm run local
```

Open:

```text
http://localhost:3000/display
```

This is the preferred URL for a display physically attached to that computer.
Provider credentials stay in the collector; the browser receives only
normalized usage data.

## Hosted display

If the project has been deployed with viewer authentication, use:

```text
https://your-dashboard.example/display
```

Sign in with the viewer code in that browser first. The code is exchanged for a
secure session cookie; do not put the viewer code in the URL, kiosk command,
shell history, or a photographed setup label. Hosted snapshots can be older
than the collector, so keep freshness warnings visible.

## Chrome kiosk on macOS

After starting the local service, launch a dedicated Chrome window:

```bash
open -na "Google Chrome" --args --kiosk http://localhost:3000/display
```

Exit kiosk mode with the platform fullscreen shortcut or quit Chrome. For a
permanent installation, also configure macOS display sleep and power behavior
for the hardware; Screen Wake Lock is a best-effort browser control.

## Raspberry Pi kiosk

A Raspberry Pi connected over the local network can open the hosted URL, or a
local URL that is deliberately exposed by a trusted reverse proxy. Follow the
official Raspberry Pi guide:

- [How to use a Raspberry Pi in kiosk mode](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/)

Replace the guide's example page with your `/display` URL. Avoid changing the
collector from `127.0.0.1` to a LAN-wide listener merely to serve the screen;
use the authenticated hosted dashboard or a carefully configured private
network proxy instead.

## Privacy checklist

- Treat usage percentages, balances, plan names, and model names as private
  account metadata.
- Do not expose the display on a public or guest Wi-Fi network without viewer
  authentication and HTTPS.
- Never add provider API keys, ingest secrets, or viewer codes to kiosk URLs.
- Use a dedicated browser profile for a permanently mounted display.
- Position the screen so guests or cameras cannot read account information.
- If the device is lost, revoke its hosted viewer session and any reverse-proxy
  access; provider credentials should never have been present on the device.
