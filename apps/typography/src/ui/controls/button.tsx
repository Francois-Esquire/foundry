import "./button.css";
import type { ComponentProps } from "react";
import { type ControlSymbolName, LineSymbol } from "../symbols/line-symbol";

type ButtonVariant = "line" | "solid";

interface ButtonLook {
  /** A symbol printed before the name. The name always stays. */
  readonly symbol?: ControlSymbolName;
  /** Solid marks the one committing action in a group. */
  readonly variant?: ButtonVariant;
}

type ButtonProps = ButtonLook &
  Omit<ComponentProps<"button">, "className" | "type"> & {
    readonly type?: "button" | "submit";
  };

/** An action. Its text names what it does. */
export function Button({
  children,
  symbol,
  type = "button",
  variant = "line",
  ...rest
}: ButtonProps) {
  return (
    <button className="ty-button" data-variant={variant} type={type} {...rest}>
      {symbol ? <LineSymbol name={symbol} /> : null}
      {children}
    </button>
  );
}

type ButtonLinkProps = ButtonLook &
  Omit<ComponentProps<"a">, "className"> & { readonly href: string };

/** A link that moves to another place, drawn as a button. */
export function ButtonLink({
  children,
  symbol,
  variant = "line",
  ...rest
}: ButtonLinkProps) {
  return (
    <a className="ty-button" data-variant={variant} {...rest}>
      {symbol ? <LineSymbol name={symbol} /> : null}
      {children}
    </a>
  );
}
