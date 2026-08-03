import { ProviderLogo } from "../provider-logo";

export function LoadingCard({
  id,
  name,
  shortName,
  accent,
}: {
  id: string;
  name: string;
  shortName: string;
  accent: string;
}) {
  return (
    <article className="provider-card provider-card--loading" aria-busy="true">
      <header className="provider-card__header">
        <div className="provider-identity">
          <ProviderLogo provider={{ id, name, shortName, accent }} />
          <div>
            <h2>{name}</h2>
            <p>Reading live quota</p>
          </div>
        </div>
      </header>
      <div className="loading-lines">
        <span />
        <span />
        <span />
      </div>
    </article>
  );
}
