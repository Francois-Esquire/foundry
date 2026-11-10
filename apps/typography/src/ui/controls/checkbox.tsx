import "./checkbox.css";
import { type ChangeEvent, useCallback } from "react";

interface CheckboxProps {
  readonly checked: boolean;
  readonly disabled?: boolean;
  /** Some, but not all, of what this box stands for is on. */
  readonly indeterminate?: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}

/** An independent yes or no. Yes is a filled box. */
export function Checkbox({
  checked,
  disabled,
  indeterminate = false,
  label,
  onChange,
}: CheckboxProps) {
  // The mixed state has no attribute, so it is set on the element itself.
  const showMixed = useCallback(
    (element: HTMLInputElement | null) => {
      if (element) {
        element.indeterminate = indeterminate;
      }
    },
    [indeterminate]
  );
  const toggle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange(event.currentTarget.checked),
    [onChange]
  );
  return (
    <label className="ty-checkbox">
      <input
        checked={checked}
        disabled={disabled}
        onChange={toggle}
        ref={showMixed}
        type="checkbox"
      />
      <span className="ty-checkbox-box" />
      <span className="ty-checkbox-label">{label}</span>
    </label>
  );
}
