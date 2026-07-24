# Attribution and provenance

This project documents both direct dependencies and product inspiration.

## Product and architecture inspiration

| Project | Relationship | Code copied? | License |
| --- | --- | --- | --- |
| [CodexBar](https://github.com/steipete/CodexBar) | Inspired the compact quota display, provider registry, and local JSON service direction | No | MIT |
| [ccusage](https://github.com/ryoppippi/ccusage) | Demonstrates a broad, provider-neutral approach to local CLI usage analysis; a future optional adapter is on the roadmap | No | MIT |
| [Kimi Code](https://github.com/MoonshotAI/kimi-code) | Public CLI structure and behavior informed Kimi compatibility | No copied implementation | MIT |
| [vinext](https://github.com/cloudflare/vinext) | Runtime used to build the Next.js app for Cloudflare | Direct dependency | MIT |
| OpenAI Sites starter | Supplied initial full-stack scaffolding and packaging conventions | Scaffold adapted | Dependency licenses apply |

The Codex JSONL estimator in this repository was implemented specifically for
this project. It reads cumulative `token_count` events and does not vendor
CodexBar or ccusage parsing code.

## Direct dependencies

The lockfile is the authoritative version record.

| Package | Role | License |
| --- | --- | --- |
| [Next.js](https://github.com/vercel/next.js) | Application framework | MIT |
| [React](https://github.com/facebook/react) | UI runtime | MIT |
| [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm) | D1 schema and queries | Apache-2.0 |
| [Cloudflare Workers SDK](https://github.com/cloudflare/workers-sdk) | Runtime plugin and deployment tooling | MIT OR Apache-2.0 |
| [Vite](https://github.com/vitejs/vite) | Build tool | MIT |

## Provider references

- [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Kimi Code repository](https://github.com/MoonshotAI/kimi-code)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)

## Trademark and affiliation

AI Usage Dashboard is not affiliated with, endorsed by, or sponsored by OpenAI,
Moonshot AI, Cloudflare, CodexBar, or ccusage. Product and model names belong to
their respective owners.
