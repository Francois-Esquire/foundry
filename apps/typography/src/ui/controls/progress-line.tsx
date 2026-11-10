import "./progress-line.css";
import { useId } from "react";

interface ProgressLineProps {
  /** What is being waited for, such as "Starting the font engine". */
  readonly label: string;
  /** From 0 to 1. Leave out while the amount of work is unknown. */
  readonly value?: number;
}

/** A hairline that shows work under way without blocking anything. */
export function ProgressLine({ label, value }: ProgressLineProps) {
  const id = useId();
  const known = value !== undefined;
  const share = known ? Math.min(1, Math.max(0, value)) : undefined;
  return (
    <div className="ty-progress">
      <span className="ty-label" id={id}>
        {label}
      </span>
      <progress
        aria-labelledby={id}
        className="ty-visually-hidden"
        max={1}
        value={share}
      />
      <span aria-hidden="true" className="ty-progress-line" data-known={known}>
        <span
          className="ty-progress-run"
          style={share === undefined ? undefined : { width: `${share * 100}%` }}
        />
      </span>
    </div>
  );
}
