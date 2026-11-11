import "./composition-list.css";
import { count } from "~/lib/count";
import { Tofu } from "./tofu";

/**
 * How a script stands in a face. The caller decides the level from what was
 * verified; this list only prints it.
 */
type CompositionStanding =
  | { readonly kind: "candidates"; readonly count: number }
  | { readonly kind: "level"; readonly level: 1 | 2 | 3 }
  | { readonly kind: "missing" };

export interface CompositionEntry {
  /** Where the name leads, such as the script's coverage. */
  readonly href?: string;
  readonly name: string;
  /** Share of the script's characters in the face, from 0 to 100. */
  readonly percent: number;
  readonly standing: CompositionStanding;
}

const DOTS = [1, 2, 3] as const;

function Standing({ standing }: { readonly standing: CompositionStanding }) {
  if (standing.kind === "candidates") {
    return (
      <span className="ty-label ty-carbon">
        {count(standing.count, "candidate")}
      </span>
    );
  }
  if (standing.kind === "missing") {
    return <Tofu label="Missing" size={11} />;
  }
  return (
    <svg
      aria-label={`Coverage level ${standing.level} of 3`}
      className="ty-composition-dots"
      height="9"
      role="img"
      viewBox="0 0 31 9"
      width="31"
    >
      {DOTS.map((dot) => (
        <circle
          className={
            dot <= standing.level ? "ty-composition-dot-on" : undefined
          }
          cx={dot * 11 - 6.5}
          cy="4.5"
          key={dot}
          r="3.5"
        />
      ))}
    </svg>
  );
}

interface CompositionListProps {
  readonly entries: readonly CompositionEntry[];
  readonly label: string;
}

/**
 * What a face is made of, listed the way a care label lists fibres: share
 * first, then the script, then how well it is covered.
 */
export function CompositionList({ entries, label }: CompositionListProps) {
  return (
    <ul aria-label={label} className="ty-composition">
      {entries.map((entry) => (
        <li key={entry.name}>
          <span>{Math.round(entry.percent)}%</span>
          {entry.href ? (
            <a href={entry.href}>{entry.name}</a>
          ) : (
            <span>{entry.name}</span>
          )}
          <Standing standing={entry.standing} />
        </li>
      ))}
    </ul>
  );
}
