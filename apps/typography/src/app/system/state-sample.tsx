import type { ReactNode } from "react";

interface StateSamplesProps {
  /** State samples. */
  readonly children: ReactNode;
  /** Lays samples out in wide cells, for controls that need room. */
  readonly wide?: boolean;
}

export function StateSamples({ children, wide = false }: StateSamplesProps) {
  return (
    <ul className="ty-system-states" data-wide={wide}>
      {children}
    </ul>
  );
}

interface StateSampleProps {
  readonly children: ReactNode;
  /**
   * Shows a pointer or keyboard state without the pointer or keyboard. The
   * stylesheets pair every forced selector with the real pseudo-class, so
   * the sample cannot drift from the control.
   */
  readonly force?: "focus" | "hover" | "over";
  readonly name: string;
}

export function StateSample({ children, force, name }: StateSampleProps) {
  return (
    <li data-force={force}>
      <div className="ty-system-sample">{children}</div>
      <span className="ty-system-state-name">{name}</span>
    </li>
  );
}

/** For samples that show a state and are not meant to be operated. */
export const ignore = () => undefined;
