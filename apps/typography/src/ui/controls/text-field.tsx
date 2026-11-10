import "./field.css";
import { type ComponentProps, useId } from "react";
import { Notice } from "./notice";

type TextFieldProps = Omit<
  ComponentProps<"input">,
  "aria-describedby" | "aria-invalid" | "className" | "id" | "type"
> & {
  /** Names the problem and the way out. Marks the field invalid. */
  readonly error?: string;
  readonly hint?: string;
  readonly label: string;
  readonly type?: "email" | "number" | "text" | "url";
};

/** A line to write on, with its name printed above. */
export function TextField({
  error,
  hint,
  label,
  type = "text",
  ...rest
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint && hintId, error && errorId]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="ty-field">
      <label className="ty-label" htmlFor={id}>
        {label}
      </label>
      <span className="ty-field-line">
        <input
          aria-describedby={describedBy || undefined}
          aria-invalid={error ? true : undefined}
          className="ty-field-input"
          id={id}
          type={type}
          {...rest}
        />
      </span>
      {hint ? (
        <p className="ty-field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <Notice id={errorId} tone="problem">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}
