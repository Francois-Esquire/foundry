import { useMemo } from "react";
import type { GlyphTarget } from "~/generation/plan/target";
import { formatCodePoint } from "~/lib/code-point";
import type { Face } from "~/typeface/face";
import { type DataColumn, DataTable } from "~/ui/content/data-table";
import { Tofu } from "~/ui/content/tofu";
import { useFontFamily } from "~/workspace/services";
import { type PartNeed, partsOf, type RequestPlan } from "./request-plan";

interface Row {
  readonly builtFrom: string;
  readonly kind: string;
  readonly target: GlyphTarget;
}

const partText = ({ character, drawnBy, role }: PartNeed): string => {
  const name =
    role === "base"
      ? `${String.fromCodePoint(character)} ${formatCodePoint(character)}`
      : `the mark ${formatCodePoint(character)}`;
  if (drawnBy === undefined) {
    return `${name}, made first in this run`;
  }
  return drawnBy === character
    ? `${name}, in the face`
    : `${name}, drawn by ${formatCodePoint(drawnBy)} in the face`;
};

const builtFrom = (target: GlyphTarget, plan: RequestPlan): string => {
  const parts = partsOf(target, plan.face);
  return parts.length > 0
    ? `Needs ${parts.map(partText).join(" and ")}.`
    : "Drawn whole. No rule builds it from other glyphs.";
};

const kindOf = (
  target: GlyphTarget,
  plan: RequestPlan,
  needed: ReadonlySet<string>
): string => {
  if (plan.holdouts.has(target.key)) {
    return "Holdout test: the face has it";
  }
  if (target.replaces?.kind === "added") {
    return "Redraws a glyph added in this project";
  }
  return needed.has(target.key)
    ? "Missing. A part, made first"
    : "Missing from the face";
};

const rowKey = (row: Row) => row.target.key;

interface TargetTableProps {
  readonly face: Face;
  readonly plan: RequestPlan;
}

/** The targets of a request in the order they are made, with what each depends on. */
export function TargetTable({ face, plan }: TargetTableProps) {
  const family = useFontFamily(face.id);
  const rows = useMemo(() => {
    const needed = new Set(plan.targets.flatMap((target) => target.needs));
    return plan.targets.map(
      (target): Row => ({
        builtFrom: builtFrom(target, plan),
        kind: kindOf(target, plan, needed),
        target,
      })
    );
  }, [plan]);
  const columns = useMemo(
    (): readonly DataColumn<Row>[] => [
      {
        cell: ({ target }) => {
          if (plan.holdouts.has(target.key)) {
            return (
              <span
                className="ty-generate-letter"
                style={{ fontFamily: family }}
              >
                {target.text}
              </span>
            );
          }
          // The crossed box is only for a character that is missing.
          return target.replaces ? "Added glyph" : <Tofu size={21} />;
        },
        header: "In the face",
        id: "letter",
        kind: "text",
      },
      {
        cell: ({ target }) =>
          target.characters.map(formatCodePoint).join(" ") || target.text,
        header: "Character",
        id: "character",
        kind: "label",
      },
      { cell: ({ kind }) => kind, header: "Target", id: "kind", kind: "text" },
      {
        cell: (row) => row.builtFrom,
        header: "Depends on",
        id: "parts",
        kind: "text",
      },
      {
        cell: ({ target }) => target.name,
        header: "Glyph name",
        id: "name",
        kind: "text",
      },
    ],
    [family, plan.holdouts]
  );
  return (
    <DataTable
      caption="Targets of this request and what each depends on"
      columns={columns}
      rowKey={rowKey}
      rows={rows}
    />
  );
}
