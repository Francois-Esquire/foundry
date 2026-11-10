import "./field.css";
import { type ChangeEvent, useCallback, useId } from "react";
import { LineSymbol } from "../symbols/line-symbol";

interface SelectOption<Value extends string> {
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: Value;
}

interface SelectProps<Value extends string> {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (value: Value) => void;
  readonly options: readonly SelectOption<Value>[];
  readonly value: Value;
}

/** One choice out of many, kept on a single line. */
export function Select<Value extends string>({
  disabled,
  label,
  onChange,
  options,
  value,
}: SelectProps<Value>) {
  const id = useId();
  const choose = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
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
    <div className="ty-field">
      <label className="ty-label" htmlFor={id}>
        {label}
      </label>
      <span className="ty-field-line">
        <select
          className="ty-field-input"
          disabled={disabled}
          id={id}
          onChange={choose}
          value={value}
        >
          {options.map((option) => (
            <option
              disabled={option.disabled}
              key={option.value}
              value={option.value}
            >
              {option.label}
            </option>
          ))}
        </select>
        <LineSymbol className="ty-field-chevron" name="chevron-down" />
      </span>
    </div>
  );
}
