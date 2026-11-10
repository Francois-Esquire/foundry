import { EmptyState } from "~/ui/content/empty-state";
import { ButtonLink } from "~/ui/controls/button";
import type { PlaceSymbolName } from "~/ui/symbols/line-symbol";

interface NoFontsProps {
  /** What this place shows once there is a font. */
  readonly children: string;
  readonly symbol: PlaceSymbolName;
}

/** What a place shows while the project holds no font, with the way to add one. */
export function NoFonts({ children, symbol }: NoFontsProps) {
  return (
    <EmptyState
      action={
        <ButtonLink href="#/import" symbol="add">
          Import a font
        </ButtonLink>
      }
      symbol={symbol}
      title="No fonts yet"
    >
      {children} Import a font, or load the samples, to begin.
    </EmptyState>
  );
}
