/**
 * Reconstructs the lettering in one region of an image and writes what it
 * found.
 *
 *   bun scripts/reconstruction/run.ts <image> <region> <output directory> [font files...]
 *
 * <region> is x,y,width,height for lettering seen head on, or eight numbers
 * x1,y1,...,x4,y4 for its four corners seen at an angle: top left, top right,
 * bottom right, bottom left. A font file may name an axis location, as in
 * SofiaSans-wght.ttf@wght=900. Reference fonts are what letters are
 * recognised against; without them, give the reading with --text.
 *
 *   --text "NEEDED THINGS/FOR SALE"   what the lettering reads, lines parted by /
 *   --characters "ABC..."             the characters to consider (A-Z, a-z, 0-9 when absent)
 *   --scale 2                         enlarge the region before isolating
 *   --by tone|colour                  how lettering is told from background
 *   --lettering darker|lighter        override the polarity
 *   --ruled                           take out ruled lines, as on lined paper
 *
 * Writes report.json, isolated.png, letters.png, letters.svg and overlay.svg.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { inkToImage } from "~/generation/sheet/drawing";
import { analyseStyle } from "~/generation/style/reference";
import { renderReferenceSheet } from "~/generation/style/reference-sheet";
import {
  importEvidence,
  mediaTypeFor,
} from "~/reconstruction/evidence/evidence";
import {
  type EvidenceRegion,
  quadrilateralRegion,
  rectangleRegion,
} from "~/reconstruction/evidence/region";
import { observedFace } from "~/reconstruction/inference/observed-face";
import { twoLevel } from "~/reconstruction/isolation/isolate";
import {
  createFaceRecognizer,
  type ReferenceFace,
} from "~/reconstruction/recognition/face-recognizer";
import { LabelCountError } from "~/reconstruction/recognition/recognizer";
import { reconstruct } from "~/reconstruction/reconstruct";
import { overlaySvg } from "~/reconstruction/report/overlay";
import { reportOf } from "~/reconstruction/report/report";
import type { AxisLocation } from "~/typeface/face";
import { nodeImageCodec } from "../generation/node-image-codec";

const DEFAULT_CHARACTERS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const fail = (problem: string): never => {
  console.error(problem);
  process.exit(1);
};

const regionOf = (text: string): EvidenceRegion => {
  const numbers = text.split(",").map(Number);
  if (numbers.some(Number.isNaN)) {
    return fail(`The region ${text} is not a list of numbers.`);
  }
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = numbers;
  if (numbers.length === 4) {
    return rectangleRegion(a, b, c, d);
  }
  if (numbers.length === 8) {
    return quadrilateralRegion([
      { x: a, y: b },
      { x: c, y: d },
      { x: e, y: f },
      { x: g, y: h },
    ]);
  }
  return fail(
    "A region is x,y,width,height or the eight numbers of four corners."
  );
};

const referenceOf = (argument: string): ReferenceFace => {
  const [file = "", axes] = argument.split("@");
  const location: AxisLocation | undefined = axes
    ? Object.fromEntries(
        axes.split(",").map((setting) => {
          const [tag = "", value] = setting.split("=");
          return [tag, Number(value)];
        })
      )
    : undefined;
  const face = harfBuzzReader.open(new Uint8Array(readFileSync(file)));
  return {
    face,
    id: argument,
    location,
    name: `${face.description.fullName}${axes ? ` at ${axes}` : ""}`,
  };
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    by: { type: "string" },
    characters: { type: "string" },
    lettering: { type: "string" },
    ruled: { type: "boolean" },
    scale: { type: "string" },
    text: { type: "string" },
  },
});
const [imagePath, regionText, outputDirectory, ...fontFiles] = positionals;
if (!(imagePath && regionText && outputDirectory)) {
  fail(
    "Usage: bun scripts/reconstruction/run.ts <image> <region> <output directory> [font files...]"
  );
}
const { by, lettering } = values;
if (by !== undefined && by !== "tone" && by !== "colour") {
  fail("--by is tone or colour.");
}
if (
  lettering !== undefined &&
  lettering !== "darker" &&
  lettering !== "lighter"
) {
  fail("--lettering is darker or lighter.");
}

const fileName = path.basename(imagePath ?? "");
const evidence = await importEvidence(
  {
    bytes: new Uint8Array(readFileSync(imagePath ?? "")),
    fileName,
    mediaType: mediaTypeFor(fileName),
  },
  nodeImageCodec
);
const references = fontFiles.map(referenceOf);
const characters = [...(values.characters ?? DEFAULT_CHARACTERS)].map(
  (character) => character.codePointAt(0) ?? 0
);
const recognizer =
  references.length > 0
    ? createFaceRecognizer(references, characters)
    : undefined;
const attempt = () => {
  try {
    return reconstruct({
      evidence,
      isolation: {
        by: by as "colour" | "tone" | undefined,
        lettering: lettering as "darker" | "lighter" | undefined,
        ruledLines: values.ruled,
      },
      recognizer,
      region: regionOf(regionText ?? ""),
      target: { faceId: "reconstruction" },
      text: values.text?.split("/"),
      view: { scale: values.scale ? Number(values.scale) : undefined },
    });
  } catch (error) {
    if (error instanceof LabelCountError) {
      return fail(error.message);
    }
    throw error;
  }
};
const reconstruction = attempt();
const nearest =
  recognizer?.nearestFaces(
    reconstruction.isolation.lines,
    reconstruction.readings
  ) ?? [];

const write = (name: string, content: string | Uint8Array) => {
  writeFileSync(path.join(outputDirectory ?? "", name), content);
};
mkdirSync(outputDirectory ?? "", { recursive: true });
write(
  "report.json",
  `${JSON.stringify(reportOf(evidence, reconstruction, nearest), null, 2)}\n`
);
write(
  "isolated.png",
  await nodeImageCodec.encodePng(
    inkToImage(twoLevel(reconstruction.isolation.ink))
  )
);
write("overlay.svg", overlaySvg(evidence, reconstruction.recovered));
const face = observedFace(
  reconstruction.distinct.map(({ candidate, character }) => ({
    advance: candidate.advance,
    character,
    outline: candidate.outline,
  })),
  reconstruction.metrics
);
const sheet = renderReferenceSheet(face, analyseStyle(face), {
  characters: [...face.characters()],
});
write("letters.svg", sheet.svg);
write("letters.png", await nodeImageCodec.encodePng(inkToImage(sheet.bitmap)));

const count = (amount: number, noun: string) =>
  `${amount} ${noun}${amount === 1 ? "" : "s"}`;
const byPerson = reconstruction.readings.filter(
  (reading) =>
    reading.character !== undefined && reading.labelledBy === "person"
).length;
const byRecognizer = reconstruction.recovered.length - byPerson;
console.log(
  [
    `${count(reconstruction.readings.length, "shape")} found.`,
    `${byPerson} labelled from the text given, ${byRecognizer} by the recogniser, whose labels are guesses.`,
    `${count(reconstruction.recovered.length, "outline")} traced, ${reconstruction.distinct.length} distinct.`,
    `Written to ${outputDirectory}.`,
  ].join(" ")
);
