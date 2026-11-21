# Dependency security maintenance

Verified 2026-11-22 against the npm advisory database. This is a point-in-time
dependency audit, not a claim that all application security issues are absent.

## Changes

Baseline: 28 affected packages (2 critical, 15 high, 11 moderate), including
13 production dependency findings. After updating and resolving the lockfile:
**0 findings in both the full and production-only dependency trees**.

- Next.js / eslint-config-next: 16.2.12 → 16.4.6.
- React / React DOM / react-server-dom-webpack: 19.2.8 → 19.3.1, aligned with
  vinext's peer requirements.
- vinext: 0.2.1 → 1.4.6; the old release pins vulnerable image-size and OG
  dependencies. This retains the same framework and Cloudflare build target.
- RSC plugin: 0.5.32 → 0.5.39; compatible Vite and Cloudflare build tools are
  resolved in the lockfile.
- Existing sharp override: 0.35.0 → 0.35.5.
- Scoped `satori → fflate` override: 0.7.5, the same-series security patch for
  its pinned 0.7.3. Remove this override when upstream adopts a patched version.
- Other compatible transitive fixes are recorded in `package-lock.json`.

Relevant upstream advisories:

- [React RSC remote code execution](https://github.com/react/react/security/advisories/GHSA-xqc2-xf4c-x3h3)
- [Next.js image optimization remote code execution](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw)
- [image-size parser denial of service](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
- [sharp image-library vulnerabilities](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
- [fflate malformed ZIP64 denial of service](https://github.com/advisories/GHSA-px8p-9vwx-vf98)

## Verification and boundaries

```bash
npm ci
npm run audit:security
npm audit --omit=dev
npm run check
npm run build:menubar
```

`audit:security` also runs in CI and fails on high/critical findings. Audit
availability depends on the registry; failures must be investigated, not
silenced with `--force`, exclusions, or a lower threshold.

The runtime regression test starts the built **Cloudflare Workers** preview on
an ephemeral loopback port, verifies `/` and `/display` render, and confirms
unauthenticated usage/history/ingest and invalid login codes are rejected. It
does not start the collector or access real accounts. The Cloudflare-target
bundle is tested with Vite preview, not the Node-only `vinext start` loader.

Client asset assertions use the manifest and actual JS contents because current
vinext emits hash-only filenames. No authorization assertion was removed.

No provider adapter, polling policy, credential file, installed application,
private deployment script, or running collector is changed by this update.
Generated build artifacts are local only and must not be committed. Updating
the source does not automatically install an app, publish npm, or deploy a
hosted instance; those are separate operations.
