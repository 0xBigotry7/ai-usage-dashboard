# Summary

<!-- What behavior does this change, and why? Keep the change focused. -->

## Checklist

- [ ] No real credentials, account IDs, hostnames, usage payloads, CLI logs,
      home-directory paths, or deployment resource IDs anywhere in the diff —
      all fixtures are synthetic.
- [ ] Tests added or updated (fixture-driven tests for provider response
      changes).
- [ ] `npm run check` passes locally (lint, typecheck, collector tests, build,
      rendered-output checks).
- [ ] `git diff --check` is clean.
- [ ] If logic, design, or code was adapted from another project:
      `docs/attribution.md` and `THIRD_PARTY_NOTICES.md` are updated with the
      source and license.
- [ ] If user-visible behavior changed: relevant docs (`README.md`, `docs/`,
      `CHANGELOG.md`) are updated.
- [ ] No estimated quota percentages are invented; inferred reset times and
      token values are labeled as estimates.
