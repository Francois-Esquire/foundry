import "./layout.css";
import { type ReactNode, useId } from "react";
import { SectionHead } from "../content/section-head";

interface RuledSectionProps {
  readonly children: ReactNode;
  /** The first section on a page carries no rule above it. */
  readonly first?: boolean;
  readonly heading: string;
  readonly lede?: string;
  readonly level?: 2 | 3;
}

/** A named part of a screen, set off by an ink rule. */
export function RuledSection({
  children,
  first = false,
  heading,
  lede,
  level,
}: RuledSectionProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="ty-section" data-first={first}>
      <SectionHead heading={heading} id={id} lede={lede} level={level} />
      {children}
    </section>
  );
}
