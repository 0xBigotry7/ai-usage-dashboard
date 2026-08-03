import type { Provider } from "../../lib/usage-types";
import { WARNING_LEVELS } from "../hooks/use-preferences";

export function ControlDock({
  providers,
  hiddenProviders,
  warningThreshold,
  riskCount,
  onToggleProvider,
  onChooseWarningThreshold,
}: {
  providers: Provider[];
  hiddenProviders: string[];
  warningThreshold: number;
  riskCount: number;
  onToggleProvider: (providerId: string) => void;
  onChooseWarningThreshold: (value: number) => void;
}) {
  return (
    <section
      className="control-dock"
      id="dashboard-controls"
      aria-label="Dashboard display settings"
    >
      <div className="control-dock__group">
        <span className="eyebrow">Providers</span>
        <div className="provider-toggles">
          {providers.map((provider) => {
            const visible = !hiddenProviders.includes(provider.id);
            return (
              <button
                key={provider.id}
                className={visible ? "is-active" : ""}
                type="button"
                onClick={() => onToggleProvider(provider.id)}
                aria-pressed={visible}
              >
                <i style={{ background: provider.accent }} />
                {provider.name}
              </button>
            );
          })}
        </div>
      </div>
      <div className="control-dock__group control-dock__threshold">
        <span className="eyebrow">Warning threshold</span>
        <div>
          {WARNING_LEVELS.map((value) => (
            <button
              key={value}
              className={warningThreshold === value ? "is-active" : ""}
              type="button"
              onClick={() => onChooseWarningThreshold(value)}
            >
              {value}%
            </button>
          ))}
        </div>
        <small>
          {riskCount
            ? `${riskCount} provider${
                riskCount > 1 ? "s" : ""
              } at the warning threshold`
            : "No providers at the warning threshold"}
        </small>
      </div>
      <div className="control-dock__shortcuts">
        <span className="eyebrow">Shortcuts</span>
        <p>
          <kbd>R</kbd> refresh <kbd>D</kbd> display view{" "}
          <kbd>,</kbd> manage
        </p>
        <small>Display preferences are stored only in this browser.</small>
      </div>
    </section>
  );
}
