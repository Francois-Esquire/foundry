import "./empty-state.css";
import type { ReactNode } from "react";
import { LineSymbol, type PlaceSymbolName } from "../symbols/line-symbol";

interface EmptyStateProps {
  /** A control that starts the way out of the empty state. */
  readonly action?: ReactNode;
  /** One or two sentences: what is absent and what to do about it. */
  readonly children: ReactNode;
  readonly symbol?: PlaceSymbolName;
  readonly title: string;
}

/** What a place shows when it has nothing to show yet. */
export function EmptyState({
  action,
  children,
  symbol,
  title,
}: EmptyStateProps) {
  return (
    <div className="ty-empty">
      {symbol ? <LineSymbol name={symbol} /> : null}
      <h2 className="ty-heading">{title}</h2>
      <p className="ty-lede">{children}</p>
      {action}
    </div>
  );
}
