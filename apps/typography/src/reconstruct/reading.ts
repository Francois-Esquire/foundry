/**
 * Reading the letters of a marked region of evidence: opening the picture
 * and keeping it with the project, finding the letter shapes, saying which
 * character each one is, and tracing them. The Reconstruct place's session and the reconstruct command call
 * these. Nothing is remembered here. The session keeps a sighting and what
 * the recogniser made of it, and decides when either needs reading again.
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

/**
 * What one reading worked out that the next can use again: the letter shapes
 * found, and what the recogniser made of them. It names what it was worked
 * out from, so a reading of other evidence, another region or other faces
 * does the work afresh.
 */
export interface ReadingMemo {
  readonly evidence: Evidence;
  readonly machine: MachineReading;
  readonly region: EvidenceRegion;
  readonly sighting: Sighting;
  readonly sightingKey: string;
}

/** Everything read from the marked region as the labels stand now. */
export interface LetterReading {
  /** The reference faces the letters were read against. */
  readonly faces: readonly ReferenceFace[];
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
  memo: ReadingMemo,
  options: ReadingOptions,
  workspace: ReadingRequest["workspace"]
) => memo.machine.key !== readerKeyOf(options, references(options, workspace));

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

/** What a photograph is kept with. */
export interface EvidenceMeans {
  readonly codec: ImageCodec;
  /** Keeps a photograph's file, frozen and named by its digest, and answers with its artifact. */
  readonly keepPhotograph: (file: {
    readonly bytes: Uint8Array;
    readonly digest: string;
    readonly fileName: string;
  }) => Promise<string>;
  readonly workspace: Pick<Workspace, "addPhotograph" | "getState">;
}

/**
 * Opens a picture file as evidence and keeps it as a photograph of the
 * project: its file as an artifact, and the photograph in the project's
 * list. However a photograph arrives, dropped on the Reconstruct place or
 * imported by command, it arrives through here, and the picture is decoded
 * this once. A file that is not a picture is refused before anything is
 * kept. `alreadyListed` is true when the project had this file, under this
 * name or another.
 */
export const keepEvidence = async (
  file: { readonly bytes: Uint8Array; readonly fileName: string },
  { codec, keepPhotograph, workspace }: EvidenceMeans
): Promise<{
  readonly alreadyListed: boolean;
  readonly artifactId: string;
  readonly evidence: Evidence;
}> => {
  const evidence = await openEvidence(file, codec);
  const { fileName, id } = evidence;
  const artifactId = await keepPhotograph({
    bytes: file.bytes,
    digest: id,
    fileName,
  });
  const alreadyListed = workspace
    .getState()
    .project.photographs.some((listed) => listed.id === id);
  workspace.addPhotograph({ fileName, id });
  return { alreadyListed, artifactId, evidence };
};

/** Reads the letters of a region. Refuses when the text does not name each letter found. */
export const readLetters = (
  request: ReadingRequest
): { readonly memo: ReadingMemo; readonly reading: LetterReading } => {
  const { evidence, options, region } = request;
  const sighting = sight(evidence, region, {
    by: options.by,
    lettering:
      options.lettering === "automatic" ? undefined : options.lettering,
    ruledLines: options.ruledLines,
    scale: options.scale,
  });
  const memo = readSighting(request, sighting);
  return { memo, reading: labelLetters(memo, request) };
};

/** Recognises a sighting against the project's faces and the characters considered. */
export const readSighting = (
  { evidence, options, region, workspace }: ReadingRequest,
  sighting: Sighting
): ReadingMemo => {
  const faces = references(options, workspace);
  const key = readerKeyOf(options, faces);
  const reader = letterReader(faces, consideredCharacters(options.considered));
  return {
    evidence,
    machine: { faces, key, reader, readings: reader.read(sighting) },
    region,
    sighting,
    sightingKey: sightingKey(options),
  };
};

/** Applies labels or a transcription and traces the recognised letters. */
export const labelLetters = (
  { evidence, machine, sighting }: ReadingMemo,
  { labels, text }: Pick<ReadingRequest, "labels" | "text">
): LetterReading => {
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
    faces: machine.faces,
    nearest: machine.reader.nearest(sighting, readings),
    readings,
    recovery: recover(evidence, sighting, readings, DRAFT_TARGET),
    references: machine.faces.length,
    sighting,
  };
};
