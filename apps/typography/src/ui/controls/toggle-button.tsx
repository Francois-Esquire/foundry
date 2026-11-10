import "./button.css";
import { type ReactNode, useCallback } from "react";
import { type ControlSymbolName, LineSymbol } from "../symbols/line-symbol";

interface ToggleButtonProps {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onPressedChange: (pressed: boolean) => void;
  readonly pressed: boolean;
  readonly symbol?: ControlSymbolName;
}

/** A setting that is either on or off. On is a filled box. */
export function ToggleButton({
  children,
  disabled,
  onPressedChange,
  pressed,
  symbol,
}: ToggleButtonProps) {
  const toggle = useCallback(
    () => onPressedChange(!pressed),
    [onPressedChange, pressed]
  );
  return (
    <button
      aria-pressed={pressed}
      className="ty-button"
      disabled={disabled}
      onClick={toggle}
      type="button"
    >
      {symbol ? <LineSymbol name={symbol} /> : null}
      {children}
    </button>
  );
}
