/**
 * The verification report in plain words: what was built, exactly which
 * characters, forms and words were checked, and what was not.
 */

import { formatCodePoint } from "~/lib/code-point";
import type { ExtensionGlyph, MadeExtension } from "./extend";
import { comparedLetters } from "./letter-identity";
import type { CheckOutcome, ShapingCheck, VerificationReport } from "./verify";
import { weightNotes } from "./weight-notes";

const mark = (pass: boolean) => (pass ? "ok" : "FAILED");

const OUTCOME_MARKS: Readonly<Record<CheckOutcome, string>> = {
  fail: "FAILED",
  "not-run": "NOT RUN",
  pass: "ok",
};

const count = (items: readonly { readonly pass: boolean }[]) =>
  `${items.filter((item) => item.pass).length} of ${items.length}`;

/** How many probes passed, of all that were planned. One that did not run is not among the passed. */
const passedOf = (items: readonly { readonly outcome: CheckOutcome }[]) =>
  `${items.filter((item) => item.outcome === "pass").length} of ${items.length}`;

const shapingLine = (check: ShapingCheck) =>
  check.pass
    ? `- ${check.text}: ${check.got.join(" ")} (ok)`
    : `- ${check.text}: FAILED. Planned ${check.expected.join(" ")}, shaped ${check.got.join(" ")}`;

const sourcesOf = ({ runs }: MadeExtension): string[] =>
  runs.map(({ record }) => {
    const origin = record.recorded
      ? "replayed from a recorded run, no model was called"
      : "generated in this run";
    return `- ${record.strategy.name}. Run ${record.runId}, output made ${record.createdAt}, ${origin}.`;
  });

const glyphLine = (glyph: ExtensionGlyph) => {
  const defects = glyph.evaluation?.defects.map((defect) => defect.detail);
  const verdict = glyph.evaluation
    ? ` Evaluation: ${glyph.evaluation.verdict}${defects && defects.length > 0 ? `. ${defects.join(" ")}` : "."}`
    : "";
  const weaknesses = glyph.evaluation?.weaknesses ?? [];
  const known =
    weaknesses.length > 0 ? ` Known weaknesses: ${weaknesses.join(" ")}` : "";
  return `- ${glyph.planned.name} (${glyph.planned.text}): ${glyph.madeBy}${verdict}${known}`;
};

export const notVerified = (
  extension: MadeExtension,
  report: VerificationReport
): string[] => {
  const { plan } = extension;
  const inWords = new Set(plan.words.flatMap((word) => word.glyphs));
  const unused = plan.glyphs.filter((glyph) => !inWords.has(glyph.name));
  const compared = new Set(comparedLetters(plan).map((glyph) => glyph.name));
  const uncompared = plan.glyphs.filter((glyph) => !compared.has(glyph.name));
  return [
    `Any character, conjunct, half form or word that is not listed above. This is not support for ${plan.script} or for a language written in it.`,
    ...(unused.length > 0
      ? [
          `In running words: ${unused.map((glyph) => `${glyph.name} (${glyph.text})`).join(", ")}. No test word uses these glyphs. They were checked only by their character mapping or by the form and mark checks above.`,
        ]
      : []),
    report.identity
      ? `The identity of ${uncompared.map((glyph) => glyph.name).join(", ")}. Vowel signs, marks and half forms were not compared with a reference face. Look at the proof sheet.`
      : "Letter identity. No reference face was given, so no generated letter was compared with a known one.",
    "How the glyphs look together. The checks compare glyph sequences, mark positions and headline joins. Whether a hook is the right length over a letter it was not drawn on, or a half form meets every following letter cleanly, is for a person to judge on the proof sheet.",
    "Marks on bases other than the one each was drawn on, beyond the test words. Each anchor is computed from the base's own stem, and only the pairs listed above were shaped and measured.",
    "Shaping engines other than the one that opened the font for these checks, and any application's own text layout.",
    "Style. The reference face tells letters apart. It is another design and says nothing about whether the new letters suit the source face.",
  ];
};

/** The report as Markdown. */
export const describeVerification = (
  extension: MadeExtension,
  report: VerificationReport
): string => {
  const { plan } = extension;
  const textOf = (name: string) =>
    plan.glyphs.find((glyph) => glyph.name === name)?.text ?? "";
  const notRun = [...report.marks, ...report.headlines].filter(
    (check) => check.outcome === "not-run"
  ).length;
  const failed = "Not every check passed. The failures are marked FAILED.";
  let verdict = report.pass ? "Every check below passed." : failed;
  if (notRun > 0) {
    verdict = `${notRun} planned ${notRun === 1 ? "probe" : "probes"} did not run. ${report.pass ? "Every check that ran passed." : failed}`;
  }
  const lines = [
    `# Verification: a ${plan.script} subset, built as ${report.familyName}`,
    "",
    verdict,
    `This is a defined subset: ${plan.glyphs.filter((glyph) => glyph.characters.length > 0).length} characters, ${plan.glyphs.filter((glyph) => glyph.characters.length === 0).length} forms with no character of their own, and ${plan.words.length} test words. It is not support for ${plan.script}.`,
    "",
    "## Where the glyphs came from",
    "",
    ...sourcesOf(extension),
    "",
    "## Verified",
    "",
    "### The built font",
    "",
    `- It ${report.validation.loadable ? "loads" : "does NOT load"} and the engine's validation reports ${report.validation.errors.length} errors and ${report.validation.warnings.length} warnings.`,
    ...report.validation.errors.map((error) => `- Error: ${error}`),
    ...report.validation.warnings.map((warning) => `- Warning: ${warning}`),
    ...report.validation.notes.map((note) => `- Engine note: ${note}`),
    `- Its layout tables name these scripts: ${report.scripts.join(", ")}.`,
    "",
    `### Characters: ${count(report.characters)} map to their own glyph`,
    "",
    ...report.characters.map(
      (check) =>
        `- ${formatCodePoint(check.character)} ${String.fromCodePoint(check.character)}: ${check.got ?? "no glyph"} (${mark(check.pass)})`
    ),
    "",
    `### Forms with no character: ${count(report.forms)} are reached by layout rules`,
    "",
    ...report.forms.map(shapingLine),
    "",
    `### Words: ${count(report.words)} shape to the planned glyphs`,
    "",
    ...report.words.map(shapingLine),
    "",
    `### Marks: ${passedOf(report.marks)} have no advance and sit on their base's stem`,
    "",
    ...report.marks.map(
      (check) =>
        `- ${check.text} (${check.mark} on ${check.base}): ${OUTCOME_MARKS[check.outcome]}. ${check.detail}`
    ),
    "",
    `### Headlines: joined in ${passedOf(report.headlines)} words`,
    "",
    ...report.headlines.map(
      (check) =>
        `- ${check.text}: ${check.outcome === "pass" ? "the headlines of neighbouring letters meet" : `${OUTCOME_MARKS[check.outcome]}. ${check.detail}`}`
    ),
    "",
    ...(report.identity
      ? [
          `### Letter identity against ${report.identity.reference}: ${count(report.identity.letters)} agree most with their own letter`,
          "",
          "Agreement is intersection over union of the two shapes, 0 to 1, with both letters on the same lines.",
          "",
          ...report.identity.letters.map((letter) =>
            letter.pass
              ? `- ${letter.name} (${textOf(letter.name)}): ${letter.ownScore.toFixed(2)} with its own letter, the highest (ok)`
              : `- ${letter.name} (${textOf(letter.name)}): FAILED. ${letter.ownScore.toFixed(2)} with its own letter, ${letter.closestScore.toFixed(2)} with ${letter.closest} (${textOf(letter.closest)})`
          ),
          "",
        ]
      : []),
    `### Latin from the source font: ${count(report.latin)} tested texts shape exactly as before`,
    "",
    ...report.latin.map((check) =>
      check.pass
        ? `- ${check.text}: the same glyphs, clusters, advances and offsets as in the source font (ok)`
        : `- ${check.text}: FAILED. It no longer shapes as it does in the source font.`
    ),
    "",
    "## Height model",
    "",
    extension.lines.rule,
    "",
    ...weightNotes(extension).map((item) => `- ${item}`),
    "",
    "The model drew each letter at a fixed ratio of stroke to height, so size and weight cannot both be matched by scaling. The rule matches size. The weight is what the figures above say.",
    "",
    "## How each glyph was made",
    "",
    ...extension.glyphs.map(glyphLine),
    ...extension.missing.map(
      ({ name, reason }) => `- ${name}: NOT MADE. ${reason}`
    ),
    "",
    "## Not verified",
    "",
    ...notVerified(extension, report).map((item) => `- ${item}`),
    "",
    ...(extension.notes.length > 0
      ? ["## Notes", "", ...extension.notes.map((note) => `- ${note}`), ""]
      : []),
  ];
  return lines.join("\n");
};
