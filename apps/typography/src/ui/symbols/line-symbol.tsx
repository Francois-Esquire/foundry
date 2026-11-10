import "./symbols.css";
import { cx } from "../cx";
import { CONTROL_DRAWINGS, PLACE_DRAWINGS } from "./drawings";

export type PlaceSymbolName = keyof typeof PLACE_DRAWINGS;
export type ControlSymbolName = keyof typeof CONTROL_DRAWINGS;
export type SymbolName = PlaceSymbolName | ControlSymbolName;

export const CONTROL_SYMBOL_NAMES = Object.keys(
  CONTROL_DRAWINGS
) as ControlSymbolName[];

const isPlaceSymbol = (name: SymbolName): name is PlaceSymbolName =>
  name in PLACE_DRAWINGS;

interface LineSymbolProps {
  readonly className?: string;
  readonly name: SymbolName;
}

/**
 * A symbol drawn in one-pixel line. It is decoration for the name printed
 * beside or below it, so it is hidden from assistive technology and never
 * stands alone.
 */
export function LineSymbol({ className, name }: LineSymbolProps) {
  const place = isPlaceSymbol(name);
  const grid = place ? 40 : 22;
  return (
    <svg
      aria-hidden="true"
      className={cx("ty-symbol", className)}
      height={grid}
      viewBox={`0 0 ${grid} ${grid}`}
      width={grid}
    >
      {place ? PLACE_DRAWINGS[name] : CONTROL_DRAWINGS[name]}
    </svg>
  );
}
