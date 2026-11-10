import "~/ui/controls/field.css";
import { type ChangeEvent, useCallback, useId } from "react";

interface KeyFieldProps {
  /** Says where the key is kept. Always shown. */
  readonly hint: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}

/**
 * A line for a provider key, in the grammar of the design system's text
 * field. What is typed is masked and never offered to the browser's autofill.
 */
export function KeyField({ hint, label, onChange, value }: KeyFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange(event.currentTarget.value),
    [onChange]
  );
  return (
    <div className="ty-field">
      <label className="ty-label" htmlFor={id}>
        {label}
      </label>
      <span className="ty-field-line">
        <input
          aria-describedby={hintId}
          autoComplete="off"
          className="ty-field-input"
          id={id}
          onChange={change}
          spellCheck={false}
          type="password"
          value={value}
        />
      </span>
      <p className="ty-field-hint" id={hintId}>
        {hint}
      </p>
    </div>
  );
}
