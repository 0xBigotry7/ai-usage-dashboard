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

## CodexBar

[CodexBar](https://github.com/steipete/CodexBar) informed interface and
architecture decisions around menu-bar information density, provider
separation, warning thresholds, and refresh behavior. Version 0.8.0 includes
small, normalized-schema adaptations of the pace projection and quota-alert
state behavior, plus a focused adaptation of CodexBar's native status-item
placement approach for macOS 26. No complete CodexBar source file or provider
parser is vendored.

The detailed implementation review used
[commit `cc8da27cec92029a6435bfee4a703a719290234e`](https://github.com/steipete/CodexBar/tree/cc8da27cec92029a6435bfee4a703a719290234e).
CodexBar is available under the MIT License, copyright (c) 2026 Peter
Steinberger. The adapted source areas and reuse decisions are listed in
[Attribution and provenance](docs/attribution.md#codexbar-implementation-review).

CodexBar is licensed under the following terms:

```text
MIT License

Copyright (c) 2026 Peter Steinberger

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

The separate `steipete/homebrew-tap` repository was inspected only to understand
the release-to-cask workflow. It had no license file at reviewed commit
[`986e7d5`](https://github.com/steipete/homebrew-tap/tree/986e7d59be28c2b59ea1f5fdfb5ce3a7c3d07bd8),
so no cask source from that repository is copied. Any future cask for this
project must be written independently against the
[Homebrew Cask Cookbook](https://docs.brew.sh/Cask-Cookbook).

[ccusage](https://github.com/ryoppippi/ccusage) demonstrates a provider-neutral
approach to local CLI usage analysis. No ccusage source code is vendored here.

For a more complete dependency and provenance summary, see
[Attribution and provenance](docs/attribution.md).
