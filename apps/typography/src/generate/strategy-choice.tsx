import { type ChangeEvent, useCallback, useId } from "react";
import type { StrategyOption } from "~/generation/strategies/offering";
import type { StrategyKind } from "~/generation/strategies/strategy";

interface StrategyChoiceProps {
  readonly disabled?: boolean;
  readonly onChange: (kind: StrategyKind) => void;
  readonly options: readonly StrategyOption[];
  readonly value: StrategyKind;
}

/**
 * One generation strategy out of the four, as ruled rows. Every row says what
 * the strategy does and whether it can run now, in the strategy's own words
 * when it cannot. A strategy that cannot run can still be chosen, so its
 * reason and the way to make it available can be read.
 */
export function StrategyChoice({
  disabled,
  onChange,
  options,
  value,
}: StrategyChoiceProps) {
  const base = useId();
  const choose = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const chosen = options.find(
        (option) => option.kind === event.currentTarget.value
      );
      if (chosen) {
        onChange(chosen.kind);
      }
    },
    [onChange, options]
  );
  return (
    <fieldset className="ty-generate-strategies" disabled={disabled}>
      <legend className="ty-visually-hidden">Generation strategy</legend>
      {options.map((option) => {
        const id = `${base}-${option.kind}`;
        return (
          <div className="ty-generate-strategy" key={option.kind}>
            <input
              aria-describedby={`${id}-text ${id}-state`}
              checked={option.kind === value}
              id={id}
              name={base}
              onChange={choose}
              type="radio"
              value={option.kind}
            />
            <label className="ty-generate-strategy-name" htmlFor={id}>
              <span className="ty-generate-strategy-box" />
              <span className="ty-label">{option.name}</span>
            </label>
            <span className="ty-generate-strategy-text" id={`${id}-text`}>
              {option.summary}
              {option.model ? ` Model: ${option.model}.` : ""}
            </span>
            <span
              className="ty-generate-strategy-state"
              data-available={option.availability.available}
              id={`${id}-state`}
            >
              <span className="ty-label ty-generate-tag">
                {option.availability.available
                  ? "Can run now"
                  : "Cannot run now"}
              </span>
              {option.availability.available ? null : (
                <span>{option.availability.reason}</span>
              )}
            </span>
          </div>
        );
      })}
    </fieldset>
  );
}
