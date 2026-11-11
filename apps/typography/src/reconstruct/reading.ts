/**
 * Reading the letters of a marked region of evidence: opening the picture,
 * finding the letter shapes, saying which character each one is, and tracing
 * them. The Reconstruct place's session and the reconstruct command call
 * these. Nothing is remembered here: a reading carries what the next reading
 * of the same region can use again, and is handed back in to use it.
 */
import type { ImageCodec } from "~/generation/raster/image-codec";
import { UnreadableImageError } from "~/generation/raster/image-codec";
import { Refusal } from "~/lib/refusal";
import { labelFromText } from "~/reconstruction/recognition/recognizer";
import type { Workspace } from "~/workspace/workspace";
import { type Considered, consideredCharacters } from "./considered-characters";
import {
  type Evidence,
  type EvidenceRegion,
  type FaceMatch,
  type LetteringPolarity,
  type LetterReader,
  labelReading,
  letterReader,
  type Reading,
  type Recovery,
  type ReferenceFace,
  readEvidence,
  recover,
  type SeparationMethod,
  type Sighting,
  STANDARD_METRICS,
  sight,
  type Target,
} from "./core";
import { referenceFaces, referencesKey } from "./references";

export interface ReadingOptions {
  readonly by: SeparationMethod;
  readonly considered: Considered;
  /** Automatic reads the polarity from the picture: the class along the border is the ground. */
  readonly lettering: "automatic" | LetteringPolarity;
  readonly ruledLines: boolean;
  /** How many view pixels are made from one pixel of the photograph. */
  readonly scale: number;
}

/** How a region is read before a person changes anything. */
export const USUAL_OPTIONS: ReadingOptions = {
  by: "colour",
  considered: "letters",
  lettering: "automatic",
  ruledLines: false,
  scale: 2,
};

/** What the recogniser made of a sighting, against one set of reference faces. */
interface MachineReading {
  readonly faces: readonly ReferenceFace[];
  /** Names the characters considered and the faces read against. */
  readonly key: string;
  readonly reader: LetterReader;
  readonly readings: readonly Reading[];
}

/** Everything read from the marked region as the labels stand now. */
export interface LetterReading {
  /** What the region was read from, kept so the next reading does only the work that changed. */
  readonly from: {
    readonly evidence: Evidence;
    readonly machine: MachineReading;
    readonly region: EvidenceRegion;
    readonly sightingKey: string;
  };
  /** The library faces ranked by resemblance to the lettering as labelled. */
  readonly nearest: readonly FaceMatch[];
  readonly readings: readonly Reading[];
  /** The letters traced against no face in particular, for inspecting their fit. */
  readonly recovery: Recovery;
  /** How many reference faces the letters were read against. */
  readonly references: number;
  readonly sighting: Sighting;
}

export interface ReadingRequest {
  readonly evidence: Evidence;
  /**
   * A person's labels by letter key. A key with no character means the
   * shape was left out: it is not a letter, or not one to recover.
   */
  readonly labels?: ReadonlyMap<string, number | undefined>;
  readonly options: ReadingOptions;
  readonly region: EvidenceRegion;
  /**
   * What the lettering reads, one text for each line, in place of labels.
   * Each needs one character for every letter found.
   */
  readonly text?: readonly string[];
  /** The project whose faces the letters are read against. */
  readonly workspace: Pick<Workspace, "getState" | "openFace">;
}

/** The key of a found letter: its line and its place in the line. */
export const letterKey = (reading: {
  readonly index: number;
  readonly line: number;
}) => `${reading.line}.${reading.index}`;

/**
 * Names what decides which letter shapes are found. Another sighting finds
 * other letters, so labels given to the old ones no longer name anything.
 */
export const sightingKey = ({
  by,
  lettering,
  ruledLines,
  scale,
}: ReadingOptions) => [by, lettering, ruledLines, scale].join("|");

const references = (
  { considered }: ReadingOptions,
  workspace: ReadingRequest["workspace"]
): ReferenceFace[] =>
  referenceFaces(
    workspace.getState().project.faces,
    (face) => workspace.openFace(face.id),
    consideredCharacters(considered)
  );

const readerKeyOf = (
  { considered }: ReadingOptions,
  faces: readonly ReferenceFace[]
) => `${considered}|${referencesKey(faces)}`;

/** True when a reading was made against other faces, or other characters, than the project and the options give now. */
export const readAgainstOthers = (
  reading: LetterReading,
  options: ReadingOptions,
  workspace: ReadingRequest["workspace"]
) =>
  reading.from.machine.key !==
  readerKeyOf(options, references(options, workspace));

const DRAFT_TARGET: Target = {
  faceId: "reconstruction-draft",
  metrics: STANDARD_METRICS,
};

/**
 * Opens a picture file as evidence, byte for byte. Refuses a file that is
 * not a picture, and says which kinds are.
 */
export const openEvidence = async (
  file: { readonly bytes: Uint8Array; readonly fileName: string },
  codec: ImageCodec
): Promise<Evidence> => {
  try {
    return await readEvidence(file, codec);
  } catch (error) {
    if (!(error instanceof UnreadableImageError)) {
      throw error;
    }
    throw new Refusal(
      `${file.fileName} could not be read as a picture. Choose a JPEG, PNG or WebP file.`,
      { cause: error }
    );
  }
};

/**
 * Reads the letters of a region. `before` is the last reading: where the
 * evidence, the region and what decides the letter shapes are the same, its
 * sighting is used again, and where the faces and the characters considered
 * are the same too, so is what the recogniser made of it. Refuses when the
 * text given does not have one character for each letter found.
 */
export const readLetters = (
  { evidence, labels, options, region, text, workspace }: ReadingRequest,
  before?: LetterReading
): LetterReading => {
  const sighted = sightingKey(options);
  const sighting =
    before?.from.evidence === evidence &&
    before.from.region === region &&
    before.from.sightingKey === sighted
      ? before.sighting
      : sight(evidence, region, {
          by: options.by,
          lettering:
            options.lettering === "automatic" ? undefined : options.lettering,
          ruledLines: options.ruledLines,
          scale: options.scale,
        });
  const faces = references(options, workspace);
  const key = readerKeyOf(options, faces);
  let machine = before?.from.machine;
  if (before?.sighting !== sighting || machine?.key !== key) {
    const reader = letterReader(
      faces,
      consideredCharacters(options.considered)
    );
    machine = { faces, key, reader, readings: reader.read(sighting) };
  }
  const given = text
    ? new Map(
        labelFromText(machine.readings, text).map((reading) => [
          letterKey(reading),
          reading.character,
        ])
      )
    : labels;
  const readings = machine.readings.map((reading) => {
    const letter = letterKey(reading);
    return given?.has(letter)
      ? labelReading(reading, given.get(letter))
      : reading;
  });
  return {
    from: { evidence, machine, region, sightingKey: sighted },
    nearest: machine.reader.nearest(sighting, readings),
    readings,
    recovery: recover(evidence, sighting, readings, DRAFT_TARGET),
    references: machine.faces.length,
    sighting,
  };
};
