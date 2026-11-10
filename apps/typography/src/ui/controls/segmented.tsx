import "./segmented.css";
import { type ChangeEvent, useCallback, useId } from "react";
import { cx } from "../cx";

interface SegmentedOption<Value extends string> {
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: Value;
}

interface SegmentedProps<Value extends string> {
  readonly disabled?: boolean;
  /** Names the group. Hidden from sight when the context already names it. */
  readonly label: string;
  readonly labelHidden?: boolean;
  readonly onChange: (value: Value) => void;
  readonly options: readonly SegmentedOption<Value>[];
  readonly value: Value;
}

/** One choice out of a few, printed as joined boxes. */
export function Segmented<Value extends string>({
  disabled,
  label,
  labelHidden,
  onChange,
  options,
  value,
}: SegmentedProps<Value>) {
  const name = useId();
  const choose = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const chosen = options.find(
        (option) => option.value === event.currentTarget.value
      );
      if (chosen) {
        onChange(chosen.value);
      }
    },
    [onChange, options]
  );
  return (
    <fieldset className="ty-segmented" disabled={disabled}>
      <legend className={cx("ty-label", labelHidden && "ty-visually-hidden")}>
        {label}
      </legend>
      <div className="ty-segmented-options">
        {options.map((option) => (
          <label className="ty-segmented-option" key={option.value}>
            <input
              checked={option.value === value}
              disabled={option.disabled}
              name={name}
              onChange={choose}
              type="radio"
              value={option.value}
            />
            <span className="ty-label">{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
