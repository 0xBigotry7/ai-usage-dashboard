# Third-party notices

AI Usage Dashboard includes and references open-source software. The lockfile
is the authoritative record for installed package versions and transitive
dependencies; each dependency remains subject to its own license.

## Lobe Icons

Provider SVG artwork under `public/brands/` was sourced from
[`@lobehub/icons-static-svg` 1.94.0](https://www.npmjs.com/package/@lobehub/icons-static-svg),
which is published by the
[Lobe Icons project](https://github.com/lobehub/lobe-icons).

Seven SVGs are bundled locally: Claude, Codex, OpenAI, Kimi, DeepSeek,
OpenRouter, and GitHub Copilot. They are used only to identify compatible
services. These product names, logos, and trademarks belong to their respective
owners. Inclusion does not imply affiliation, endorsement, or sponsorship.

Lobe Icons is licensed under the following terms:

```text
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Source: [Lobe Icons license](https://github.com/lobehub/lobe-icons/blob/master/LICENSE).

## Inspiration, without copied source

[CodexBar](https://github.com/steipete/CodexBar) informed interface and
architecture decisions around menu-bar information density, provider
separation, warning thresholds, and refresh behavior. No CodexBar source code
was copied into this project.

[ccusage](https://github.com/ryoppippi/ccusage) demonstrates a provider-neutral
approach to local CLI usage analysis. No ccusage source code is vendored here.

For a more complete dependency and provenance summary, see
[Attribution and provenance](docs/attribution.md).
