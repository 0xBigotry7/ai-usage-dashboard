# Contributing

Contributions are welcome, especially provider adapters, synthetic fixtures,
accessibility improvements, small-screen QA, and documentation.

## Development

```bash
npm ci
npm run check
```

`npm run check` runs ESLint, TypeScript, collector tests, a production build,
and rendered-output checks.

## Pull requests

- Keep changes focused and explain the behavior being changed.
- Add fixture-driven tests for provider response changes.
- Never commit real credentials, account IDs, hostnames, usage payloads, CLI
  logs, home-directory paths, or deployment resource IDs.
- Do not estimate a missing quota percentage.
- Label inferred reset times and token values as estimates.
- Update `docs/attribution.md` when adapting logic, design, or code from another
  project.

Before submitting:

```bash
npm run check
git diff --check
```

## Adding a provider

1. Add one adapter under `collector/providers/`.
2. Register it in `collector/providers/index.mjs`.
3. Normalize into the shared provider/window/token schema.
4. Keep credentials outside the returned provider object.
5. Add synthetic normalization and sanitizer tests.
6. Document whether the endpoint is public and stable.
7. Verify desktop and compact views with missing windows and error states.

Private or machine-specific collectors should not be committed. Use the custom
sanitized snapshot protocol instead.

## Code of conduct

Be respectful, keep technical disagreement specific, and do not publish another
person's account or usage data.
