import "./layout.css";
import type { ReactNode } from "react";

interface ScrollRegionProps {
  readonly axis?: "both" | "x" | "y";
  readonly children: ReactNode;
  /** Names the region, so it can be found and scrolled from the keyboard. */
  readonly label: string;
}

/** Content that scrolls inside a frame whose size its parent sets. */
export function ScrollRegion({
  axis = "y",
  children,
  label,
}: ScrollRegionProps) {
  return (
    <section aria-label={label} className="ty-scroll" data-axis={axis}>
      {children}
    </section>
  );
}
