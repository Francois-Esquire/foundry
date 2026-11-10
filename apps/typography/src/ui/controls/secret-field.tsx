import "./field.css";
import { type ChangeEvent, useCallback, useId } from "react";

interface SecretFieldProps {
  /** Says where the secret is kept. Always shown. */
  readonly hint: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}

/**
 * A line for a secret such as a provider key. What is typed is masked, never
 * offered to the browser's autofill, and kept only by whoever holds `value`.
 */
export function SecretField({
  hint,
  label,
  onChange,
  value,
}: SecretFieldProps) {
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
