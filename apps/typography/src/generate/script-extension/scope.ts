/**
 * The scope of a script extension plan, in the plan's own figures and in the
 * words the verification report uses for them. A plan is a defined subset:
 * the scope is never widened to the script or to a language.
 */
import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";

export interface ExtensionScope {
  /** Planned glyphs a character maps to. */
  readonly characters: number;
  /** Planned glyphs no character maps to: only layout rules reach them. */
  readonly forms: number;
  readonly glyphs: number;
  readonly script: string;
  readonly words: number;
}

export const scopeOf = (plan: ScriptExtensionPlan): ExtensionScope => {
  const characters = plan.glyphs.filter(
    (glyph) => glyph.characters.length > 0
  ).length;
  return {
    characters,
    forms: plan.glyphs.length - characters,
    glyphs: plan.glyphs.length,
    script: plan.script,
    words: plan.words.length,
  };
};

/** The scope in one statement, worded as the verification report words it. */
export const scopeStatement = (plan: ScriptExtensionPlan): string => {
  const { characters, forms, script, words } = scopeOf(plan);
  return `This is a defined subset: ${characters} characters, ${forms} forms with no character of their own, and ${words} test words. It is not support for ${script}.`;
};

/** Every character the plan maps to a glyph, in plan order. */
export const plannedCharacters = (plan: ScriptExtensionPlan): number[] =>
  plan.glyphs.flatMap((glyph) => glyph.characters);
