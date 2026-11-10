/**
 * Writes the layout rules a plan's glyphs need as OpenType feature code:
 * substitutions that reach the forms no character maps to, mark attachment
 * from the glyphs' own anchors, and the glyph classes a shaper reads.
 */
import type { Point } from "~/typeface/outline";
import type { ScriptExtensionPlan } from "./plan";
import type { SettledGlyph } from "./settle";

export interface FeatureCode {
  readonly code: string;
  /** Rules the plan wanted that were left out, each with the reason. */
  readonly omitted: readonly string[];
}

const anchor = ({ x, y }: Point) =>
  `<anchor ${Math.round(x)} ${Math.round(y)}>`;

const feature = (tag: string, rules: readonly string[]) =>
  rules.length === 0
    ? []
    : [`feature ${tag} {`, ...rules.map((rule) => `  ${rule}`), `} ${tag};`];

const glyphClass = (names: readonly string[]) =>
  names.length === 0 ? "" : `[${names.join(" ")}]`;

export const featureCodeFor = (
  plan: ScriptExtensionPlan,
  glyphs: readonly SettledGlyph[]
): FeatureCode => {
  const made = new Set(glyphs.map((glyph) => glyph.planned.name));
  const omitted: string[] = [];
  const whenMade = (name: string, needs: readonly string[], rule: string) => {
    const lacking = needs.filter((need) => !made.has(need));
    if (lacking.length > 0) {
      omitted.push(
        `${name} cannot be reached: ${lacking.join(", ")} was not made.`
      );
      return [];
    }
    return [rule];
  };
  const conjuncts = glyphs.flatMap(({ planned }) =>
    planned.rule.kind === "conjunct"
      ? whenMade(
          planned.name,
          planned.rule.parts,
          `sub ${planned.rule.parts.join(" ")} by ${planned.name};`
        )
      : []
  );
  const halfForms = glyphs.flatMap(({ planned }) =>
    planned.rule.kind === "half-form"
      ? whenMade(
          planned.name,
          [planned.rule.of, planned.rule.joiner],
          `sub ${planned.rule.of} ${planned.rule.joiner} by ${planned.name};`
        )
      : []
  );
  const isMark = (glyph: SettledGlyph) =>
    glyph.planned.rule.kind === "mark-above" ||
    glyph.planned.rule.kind === "mark-below";
  const attachment = (side: "above" | "below", tag: string) => {
    const kind = side === "above" ? "mark-above" : "mark-below";
    const className = `@${plan.iso15924}_${side}`;
    const marks = glyphs.flatMap((glyph) => {
      const point = glyph.anchors[side];
      return glyph.planned.rule.kind === kind && point
        ? [`markClass ${glyph.planned.name} ${anchor(point)} ${className};`]
        : [];
    });
    const carriers = glyphs.flatMap((glyph) => {
      const point = glyph.anchors[side];
      return !isMark(glyph) && point
        ? [`pos base ${glyph.planned.name} ${anchor(point)} mark ${className};`]
        : [];
    });
    return marks.length > 0 && carriers.length > 0
      ? [...marks, ...feature(tag, carriers)]
      : [];
  };
  const { features, tags } = plan.layout;
  const code = [
    "languagesystem DFLT dflt;",
    ...tags.map((tag) => `languagesystem ${tag} dflt;`),
    ...feature(features.conjunct, conjuncts),
    ...feature(features.halfForm, halfForms),
    ...attachment("above", features.markAbove),
    ...attachment("below", features.markBelow),
    "table GDEF {",
    `  GlyphClassDef ${glyphClass(
      glyphs
        .filter((glyph) => !isMark(glyph))
        .map((glyph) => glyph.planned.name)
    )}, , ${glyphClass(glyphs.filter(isMark).map((glyph) => glyph.planned.name))}, ;`,
    "} GDEF;",
  ].join("\n");
  return { code, omitted };
};
