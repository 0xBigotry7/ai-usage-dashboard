import palette from "../public/brands/palette.json";
import type { CSSProperties } from "react";

type ProviderIdentity = {
  id: string;
  name: string;
  shortName: string;
  accent: string;
};

const BRAND_ASSETS: Record<string, string> = {
  codex: "/brands/codex.svg",
  claude: "/brands/claude.svg",
  "claude-fable": "/brands/claude.svg",
  "openai-api": "/brands/openai.svg",
  kimi: "/brands/kimi.svg",
  deepseek: "/brands/deepseek.svg",
  openrouter: "/brands/openrouter.svg",
  "github-copilot": "/brands/githubcopilot.svg",
  grok: "/brands/grok.svg",
  "grok-bot": "/brands/grok.svg",
  cursor: "/brands/cursor.svg",
  antigravity: "/brands/antigravity-mark.svg",
  gemini: "/brands/gemini.svg",
};

export function brandAccent(provider: Pick<ProviderIdentity, "id" | "accent">) {
  return (palette as Record<string, string[]>)[provider.id]?.[0] ?? provider.accent;
}

export function ProviderLogo({
  provider,
  className = "",
}: {
  provider: ProviderIdentity;
  className?: string;
}) {
  const asset = BRAND_ASSETS[provider.id];
  const style = {
    "--provider-accent": brandAccent(provider),
    ...(asset ? { "--provider-logo": `url("${asset}")` } : {}),
  } as CSSProperties;

  return (
    <span
      className={`provider-logo ${asset ? "provider-logo--asset" : "provider-logo--fallback"} ${className}`}
      style={style}
      aria-label={`${provider.name} logo`}
      role="img"
    >
      {asset ? <i aria-hidden="true" /> : provider.shortName}
    </span>
  );
}
