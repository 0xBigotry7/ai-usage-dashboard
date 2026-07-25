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
  "openai-api": "/brands/openai.svg",
  kimi: "/brands/kimi.svg",
  deepseek: "/brands/deepseek.svg",
  openrouter: "/brands/openrouter.svg",
  "github-copilot": "/brands/githubcopilot.svg",
};

export function ProviderLogo({
  provider,
  className = "",
}: {
  provider: ProviderIdentity;
  className?: string;
}) {
  const asset = BRAND_ASSETS[provider.id];
  const style = {
    "--provider-accent": provider.accent,
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
