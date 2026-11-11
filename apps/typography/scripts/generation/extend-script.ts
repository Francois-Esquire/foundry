/**
 * Extends a font into a planned part of another script from a recorded run,
 * in Node, without calling any model. Writes the derived font, a
 * verification report that says exactly what was checked, and an SVG proof
 * sheet that sets every test word in the derived font's own outlines.
 *
 *   bun scripts/generation/extend-script.ts <source font> <run directory> <output directory>
 *     [--reference <font file>]  a font of the same script, to check that each
 *                                generated letter is the letter it should be.
 *                                A check of letter identity only, never of style.
 *     [--plan <name>]            the script extension plan. devanagari-subset
 *                                by default, and the only one so far.
 */
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { nodeImageCodec } from "~/generation/node-image-codec";
import { DEVANAGARI_SUBSET } from "~/generation/script-extension/devanagari-subset";
import {
  extendScript,
  type ScriptExtension,
} from "~/generation/script-extension/extend";
import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";
import {
  listedCells,
  plannedSheetStrategy,
} from "~/generation/script-extension/planned-sheet";
import { drawProofSheet } from "~/generation/script-extension/proof-sheet";
import { describeVerification } from "~/generation/script-extension/verification-report";
import {
  type VerificationReport,
  verifyExtension,
} from "~/generation/script-extension/verify";
import { loadRecordedRuns } from "~/generation/strategies/recorded/manifest";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { derivedFamilyName } from "~/packaging/licence";
import {
  addSource,
  commit,
  digestOf,
  emptyProject,
  workingFaceOf,
} from "~/typeface/project";

const PLANS: Readonly<Record<string, ScriptExtensionPlan | undefined>> = {
  "devanagari-subset": DEVANAGARI_SUBSET,
};

export interface ExtendOptions {
  readonly outputDirectory: string;
  readonly plan: ScriptExtensionPlan;
  /** A font of the same script, for the letter identity check. */
  readonly referenceFont?: string;
  readonly runDirectory: string;
  readonly sourceFont: string;
}

export interface WrittenExtension {
  readonly extension: ScriptExtension;
  readonly files: {
    readonly font: string;
    readonly proofSheet: string;
    readonly report: string;
  };
  readonly report: VerificationReport;
}

const readBytes = (file: string) => new Uint8Array(readFileSync(file));

const readDirectory = (directory: string): Map<string, Uint8Array> =>
  new Map(
    readdirSync(directory)
      .filter((name) => statSync(path.join(directory, name)).isFile())
      .map((name) => [name, readBytes(path.join(directory, name))])
  );

/**
 * Runs the extension, records it in a project as one revision, builds the
 * derived font from that project's working face, verifies it and writes the
 * three files.
 */
export const writeExtension = async (
  options: ExtendOptions
): Promise<WrittenExtension> => {
  const { plan } = options;
  const source = readBytes(options.sourceFont);
  const face = harfBuzzReader.open(source);
  const imported = addSource(
    emptyProject(),
    {
      bytes: source,
      fileName: path.basename(options.sourceFont),
      id: await digestOf(source),
      importedAt: new Date().toISOString(),
    },
    [face.description]
  );
  const faceId = imported.faces[0]?.id ?? "";
  const files = readDirectory(options.runDirectory);
  const manifest = files.get("run.json");
  if (!manifest) {
    throw new Error(`${options.runDirectory} has no run.json.`);
  }
  const extension = await extendScript({
    codec: nodeImageCodec,
    face,
    faceId,
    plan,
    sheets: loadRecordedRuns(new TextDecoder().decode(manifest), files).map(
      (run) => ({
        cells: listedCells(run),
        strategy: plannedSheetStrategy(run, plan),
      })
    ),
  });
  const project = commit(imported, {
    changes: extension.changes,
    label: `Add a ${plan.script} subset`,
  });
  const { familyName } = derivedFamilyName(
    face.description,
    `${plan.script} Subset`
  );
  const reference = options.referenceFont
    ? harfBuzzReader.open(readBytes(options.referenceFont))
    : undefined;
  const verification = await verifyExtension({
    builder: await nodeFontBuilder(),
    extension,
    familyName,
    reader: harfBuzzReader,
    reference: reference && {
      face: reference,
      name: reference.description.familyName,
    },
    source: { bytes: source, faceIndex: 0 },
    working: workingFaceOf(project, faceId),
  });
  mkdirSync(options.outputDirectory, { recursive: true });
  const written = {
    font: path.join(
      options.outputDirectory,
      `${familyName.replaceAll(" ", "")}-${face.description.styleName.replaceAll(" ", "")}.ttf`
    ),
    proofSheet: path.join(options.outputDirectory, "proof-sheet.svg"),
    report: path.join(options.outputDirectory, "verification.md"),
  };
  await Promise.all([
    writeFile(written.font, verification.font),
    writeFile(
      written.report,
      describeVerification(extension, verification.report)
    ),
    writeFile(
      written.proofSheet,
      drawProofSheet({
        derived: verification.derived,
        extension,
        report: verification.report,
      })
    ),
  ]);
  verification.derived.close();
  reference?.close();
  face.close();
  return { extension, files: written, report: verification.report };
};

const USAGE =
  "Usage: bun scripts/generation/extend-script.ts <source font> <run directory> <output directory> [--reference <font file>] [--plan <name>]";

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      plan: { default: "devanagari-subset", type: "string" },
      reference: { type: "string" },
    },
  });
  const [sourceFont, runDirectory, outputDirectory] = positionals;
  const plan = PLANS[values.plan];
  if (!(sourceFont && runDirectory && outputDirectory)) {
    throw new Error(USAGE);
  }
  if (!plan) {
    throw new Error(
      `There is no plan named ${values.plan}. The plans are: ${Object.keys(PLANS).join(", ")}.`
    );
  }
  const { files, report } = await writeExtension({
    outputDirectory,
    plan,
    referenceFont: values.reference,
    runDirectory,
    sourceFont,
  });
  console.log(
    `${report.pass ? "Every check passed." : "Not every check passed."} ${report.words.filter((word) => word.pass).length} of ${report.words.length} test words shape as planned.`
  );
  console.log(`Derived font: ${files.font}`);
  console.log(`Verification report: ${files.report}`);
  console.log(`Proof sheet: ${files.proofSheet}`);
  if (!report.pass) {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
