import "./field.css";
import { type ChangeEvent, useCallback, useId, useRef } from "react";
import { LineSymbol } from "../symbols/line-symbol";

interface SearchFieldProps {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (query: string) => void;
  readonly placeholder?: string;
  readonly value: string;
}

/** A field that filters what is on screen as the query is typed. */
export function SearchField({
  disabled,
  label,
  onChange,
  placeholder,
  value,
}: SearchFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange(event.currentTarget.value),
    [onChange]
  );
  const clear = useCallback(() => {
    onChange("");
    input.current?.focus();
  }, [onChange]);
  return (
    <div className="ty-field">
      <label className="ty-label" htmlFor={id}>
        {label}
      </label>
      <span className="ty-field-line">
        <LineSymbol name="search" />
        <input
          className="ty-field-input"
          disabled={disabled}
          id={id}
          onChange={type}
          placeholder={placeholder}
          ref={input}
          type="search"
          value={value}
        />
        {value === "" ? null : (
          <button
            className="ty-label ty-field-clear"
            onClick={clear}
            type="button"
          >
            Clear
          </button>
        )}
      </span>
    </div>
  );
}
