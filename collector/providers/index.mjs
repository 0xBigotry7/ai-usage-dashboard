import { collectCodexUsage } from "./codex.mjs";
import { collectKimiUsage } from "./kimi.mjs";

export const providerAdapters = [
  {
    id: "codex",
    collect: collectCodexUsage,
  },
  {
    id: "kimi",
    collect: collectKimiUsage,
  },
];

export async function collectLocalProviders(env = process.env) {
  return Promise.all(
    providerAdapters.map((adapter) => adapter.collect(env)),
  );
}
