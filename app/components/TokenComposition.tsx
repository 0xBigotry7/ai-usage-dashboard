import { exactTokens, formatTokens } from "../../lib/format";

export function TokenComposition({
  inputTokens,
  outputTokens,
  cachedInputTokens,
  reasoningOutputTokens,
  compact = false,
}: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  compact?: boolean;
}) {
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number"
  ) {
    return null;
  }
  return (
    <div className={`token-composition ${compact ? "token-composition--compact" : ""}`}>
      <div aria-label="Total equals input plus output">
        <span>
          Input <b title={exactTokens(inputTokens)}>{formatTokens(inputTokens)}</b>
        </span>
        <i aria-hidden="true">+</i>
        <span>
          Output <b title={exactTokens(outputTokens)}>{formatTokens(outputTokens)}</b>
        </span>
        <i aria-hidden="true">=</i>
        <span>Total</span>
      </div>
      {!compact &&
      (typeof cachedInputTokens === "number" ||
        typeof reasoningOutputTokens === "number") ? (
        <small>
          {typeof cachedInputTokens === "number"
            ? `incl. cached input ${formatTokens(cachedInputTokens)}`
            : ""}
          {typeof cachedInputTokens === "number" &&
          typeof reasoningOutputTokens === "number"
            ? " · "
            : ""}
          {typeof reasoningOutputTokens === "number"
            ? `incl. reasoning output ${formatTokens(reasoningOutputTokens)}`
            : ""}
          {" · "}cached input and reasoning output are subsets, not added twice
        </small>
      ) : null}
    </div>
  );
}
