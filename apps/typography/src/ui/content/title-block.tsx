import "./title-block.css";
import type { CSSProperties, ReactNode } from "react";

interface TitleBlockProps {
  /** Title block items. */
  readonly children: ReactNode;
}

/**
 * The ruled row of labelled facts that heads a drawing, like the title
 * block on a technical sheet. Items wrap onto ruled rows when space runs out.
 */
export function TitleBlock({ children }: TitleBlockProps) {
  return (
    <div className="ty-title-block">
      <dl>{children}</dl>
    </div>
  );
}

interface TitleBlockItemProps {
  readonly children: ReactNode;
  readonly label: string;
  /** Share of the row this item takes, relative to its neighbours. */
  readonly weight?: number;
}

export function TitleBlockItem({
  children,
  label,
  weight = 1,
}: TitleBlockItemProps) {
  return (
    <div style={{ "--ty-weight": weight } as CSSProperties}>
      <dt className="ty-label">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
