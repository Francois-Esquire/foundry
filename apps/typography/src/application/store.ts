/**
 * How the app's things are kept as artifacts. An imported font and an
 * imported photograph are one frozen artifact each, named by the digest of
 * the file, so the same file is never kept twice. Model output is one frozen
 * artifact holding a recorded run's files. An exported font is one artifact
 * for each file name, and every export of that name is a new frozen Content
 * of it. The project is one artifact whose file is written in place.
 */
import {
  type ArtifactId,
  type Artifacts,
  artifactIdSchema,
  type ContentId,
  contentIdSchema,
  type EntryInputs,
} from "@foundry/artifacts";
import { sha256Hex } from "@foundry/lib/digest";
import type { BuiltFont } from "~/export/build-run";
import type { Change } from "~/typeface/changes";
import { Refusal } from "./refusal";

const TYPE = {
  export: "application/vnd.foundry.typography.derived-font",
  modelOutput: "application/vnd.foundry.typography.model-output",
  photograph: "application/vnd.foundry.typography.photograph",
  project: "application/vnd.foundry.typography.project",
  sourceFont: "application/vnd.foundry.typography.source-font",
} as const;

const PROJECT_FILE = "project.json";
const CHECKS_FILE = "checks.json";
const CHANGE_SET_FILE = "change-set.json";
const JSON_MIME = "application/json";

const MIMES: Readonly<Record<string, string>> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: JSON_MIME,
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttc: "font/collection",
  ttf: "font/ttf",
  txt: "text/plain",
  webp: "image/webp",
  woff2: "font/woff2",
};

const mimeOf = (fileName: string): string | null =>
  MIMES[fileName.split(".").at(-1)?.toLowerCase() ?? ""] ?? null;

/** One version of an artifact. Without a Content it means the latest. */
export interface ArtifactRef {
  readonly artifactId: string;
  readonly contentId?: string;
}

/** An exported font's artifact, with how many times that file name was exported. */
export interface KeptExport {
  readonly artifactId: string;
  readonly fileName: string;
  readonly versions: number;
}

export interface Store {
  /** The exported fonts, in the order their artifacts were listed. */
  exports(): Promise<KeptExport[]>;
  /**
   * Keeps one export of a built font and what was checked in it. The first
   * export of a file name makes its artifact. A later one adds a Content to
   * it. Answers with the export as it is now kept and the Content this one
   * made.
   */
  keepExport(
    artifactId: string | undefined,
    font: BuiltFont
  ): Promise<KeptExport & { readonly contentId: string }>;
  /** Keeps a recorded run's files, frozen. The same files are kept once. */
  keepModelOutput(
    name: string,
    files: ReadonlyMap<string, Uint8Array>
  ): Promise<string>;
  /** Keeps a photograph, frozen and named by its digest. */
  keepPhotograph(file: {
    readonly bytes: Uint8Array;
    readonly digest: string;
    readonly fileName: string;
  }): Promise<string>;
  /** Keeps a source font, frozen and named by its digest. */
  keepSourceFont(file: {
    readonly bytes: Uint8Array;
    readonly digest: string;
    readonly fileName: string;
  }): Promise<string>;
  /**
   * Keeps a waiting run: its model output, frozen, with the change set that
   * puts it into its face.
   */
  keepWaitingRun(
    name: string,
    files: ReadonlyMap<string, Uint8Array>,
    changes: readonly Change[]
  ): Promise<string>;
  /**
   * The bytes of one file of an artifact: the named one, else the one the
   * artifact is about. Refuses when the artifact or the file is not there.
   */
  read(ref: ArtifactRef, path?: string): Promise<Uint8Array>;
  /** The saved project's text, as `saveProject` wrote it. */
  readProject(artifactId: string): Promise<string>;
  /**
   * The change set kept with a waiting run's model output. Refuses when the
   * artifact holds none, or holds one that is not a change set.
   */
  readWaitingRun(artifactId: string): Promise<readonly Change[]>;
  /** Writes the project file in place and returns its artifact. */
  saveProject(
    artifactId: string | undefined,
    name: string,
    text: string
  ): Promise<string>;
}

const artifactIdOf = (id: string): ArtifactId => artifactIdSchema.parse(id);
const contentIdOf = (id: string): ContentId => contentIdSchema.parse(id);

/**
 * A digest of a set of files that does not depend on their order. Kept model
 * output is named by it, so it stays as it is: `digestTree` in the artifacts
 * package digests the same files to another answer.
 */
const digestOfFiles = async (
  files: ReadonlyMap<string, Uint8Array>
): Promise<string> => {
  const lines: string[] = [];
  for (const [name, bytes] of files) {
    lines.push(`${await sha256Hex(bytes)} ${name}`);
  }
  return sha256Hex(lines.sort().join("\n"));
};

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null;

const isGlyphRef = (value: unknown): boolean =>
  isFields(value) &&
  (value.kind === "source"
    ? typeof value.glyphId === "number"
    : value.kind === "added" && typeof value.key === "string");

const isAddedGlyph = (value: unknown): boolean =>
  isFields(value) &&
  typeof value.key === "string" &&
  typeof value.name === "string" &&
  typeof value.advance === "number" &&
  Array.isArray(value.characters) &&
  isFields(value.outline);

/** True for a change as a change set spells it: its kind, its face and what that kind carries. */
const isChange = (value: unknown): value is Change => {
  if (!(isFields(value) && typeof value.faceId === "string")) {
    return false;
  }
  switch (value.kind) {
    case "outline-replaced":
      return isGlyphRef(value.glyph) && isFields(value.outline);
    case "advance-changed":
      return isGlyphRef(value.glyph) && typeof value.advance === "number";
    case "glyph-added":
      return isAddedGlyph(value.glyph);
    case "glyph-removed":
      return typeof value.key === "string";
    case "features-added":
      return (
        typeof value.code === "string" && typeof value.description === "string"
      );
    default:
      return false;
  }
};

/** The artifact of the project these artifacts hold, when they hold one. */
export const findProject = async (
  artifacts: Artifacts
): Promise<string | undefined> => {
  const page = await artifacts.list({ limit: 1, type: TYPE.project });
  return page.items[0]?.id;
};

export const createStore = (artifacts: Artifacts): Store => {
  /** Makes a frozen artifact under a known id, unless it is already there. */
  const keepOnce = async (
    id: string,
    made: {
      readonly entries: EntryInputs;
      readonly entry?: string;
      readonly name: string;
      readonly type: string;
    }
  ): Promise<string> => {
    const artifactId = artifactIdOf(id);
    if (!(await artifacts.get(artifactId))) {
      await artifacts.create({
        entries: made.entries,
        freeze: {},
        id: artifactId,
        metadata: made.entry === undefined ? {} : { entry: made.entry },
        name: made.name,
        type: made.type,
      });
    }
    return id;
  };

  const keepFile = (
    id: string,
    type: string,
    file: { readonly bytes: Uint8Array; readonly fileName: string }
  ) =>
    keepOnce(id, {
      entries: {
        [file.fileName]: { bytes: file.bytes, mime: mimeOf(file.fileName) },
      },
      entry: file.fileName,
      name: file.fileName,
      type,
    });

  const contentOf = async (ref: ArtifactRef): Promise<ContentId> => {
    const artifact = await artifacts.get(artifactIdOf(ref.artifactId));
    if (!artifact) {
      throw new Refusal(
        `There is no artifact ${ref.artifactId} in this project's store.`
      );
    }
    if (ref.contentId !== undefined) {
      const content = await artifacts.getContent(contentIdOf(ref.contentId));
      if (content?.artifactId !== artifact.id) {
        throw new Refusal(
          `The artifact ${ref.artifactId} has no version ${ref.contentId}.`
        );
      }
      return content.id;
    }
    if (!artifact.content) {
      throw new Refusal(`The artifact ${ref.artifactId} holds no file yet.`);
    }
    return artifact.content.id;
  };

  const read: Store["read"] = async (ref, path) => {
    const contentId = await contentOf(ref);
    const file =
      path === undefined
        ? await artifacts.readRoot(contentId)
        : await artifacts.readFile(contentId, path);
    if (!file) {
      throw new Refusal(
        path === undefined
          ? `The artifact ${ref.artifactId} is not one file, so it cannot be read as one.`
          : `The artifact ${ref.artifactId} has no file named ${path}.`
      );
    }
    return file.blob;
  };

  const keepModelOutput: Store["keepModelOutput"] = async (name, files) =>
    keepOnce(`model-output-${await digestOfFiles(files)}`, {
      entries: Object.fromEntries(
        [...files].map(([fileName, bytes]) => [
          fileName,
          { bytes, mime: mimeOf(fileName) },
        ])
      ),
      name,
      type: TYPE.modelOutput,
    });

  return {
    async exports() {
      const kept: KeptExport[] = [];
      let cursor: Awaited<ReturnType<Artifacts["list"]>>["nextCursor"];
      do {
        const page = await artifacts.list({ cursor, type: TYPE.export });
        for (const artifact of page.items) {
          const contents = await artifacts.listContents(artifact.id, {
            state: "frozen",
          });
          kept.push({
            artifactId: artifact.id,
            fileName: artifact.name,
            versions: contents.length,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return kept;
    },
    keepExport(artifactId, font) {
      const { fileName } = font;
      const checks = {
        builtAt: font.builtAt,
        checks: font.report.checks,
        faceId: font.faceId,
        notes: font.notes,
        passed: font.report.passed,
        revisionId: font.revisionId,
      };
      const entries: EntryInputs = {
        [CHECKS_FILE]: { bytes: JSON.stringify(checks), mime: JSON_MIME },
        [fileName]: { bytes: font.bytes, mime: mimeOf(fileName) },
      };
      return artifacts.transaction(async (grouped) => {
        const existing =
          artifactId === undefined
            ? null
            : await grouped.get(artifactIdOf(artifactId));
        if (!existing?.content) {
          const made = await grouped.create({
            entries,
            freeze: {},
            metadata: { entry: fileName },
            name: fileName,
            type: TYPE.export,
          });
          if (!made.content) {
            throw new Error(`The export ${fileName} was kept without a file.`);
          }
          return {
            artifactId: made.id,
            contentId: made.content.id,
            fileName,
            versions: 1,
          };
        }
        const revised = await grouped.revise({
          artifactId: existing.id,
          changes: { put: entries, replace: true },
          contentId: existing.content.id,
          expectedUpdatedAt: existing.content.updatedAt,
        });
        const frozen = await grouped.freeze(revised.id);
        const versions = await grouped.listContents(existing.id, {
          state: "frozen",
        });
        return {
          artifactId: existing.id,
          contentId: frozen.id,
          fileName,
          versions: versions.length,
        };
      });
    },
    keepModelOutput,
    keepPhotograph: (file) =>
      keepFile(`photograph-${file.digest}`, TYPE.photograph, file),
    keepSourceFont: (file) =>
      keepFile(`source-font-${file.digest}`, TYPE.sourceFont, file),
    keepWaitingRun: (name, files, changes) =>
      keepModelOutput(
        name,
        new Map([
          ...files,
          [CHANGE_SET_FILE, new TextEncoder().encode(JSON.stringify(changes))],
        ])
      ),
    read,
    readProject: async (artifactId) =>
      new TextDecoder().decode(await read({ artifactId }, PROJECT_FILE)),
    async readWaitingRun(artifactId) {
      const text = new TextDecoder().decode(
        await read({ artifactId }, CHANGE_SET_FILE)
      );
      let changes: unknown;
      try {
        changes = JSON.parse(text);
      } catch {
        changes = undefined;
      }
      if (!(Array.isArray(changes) && changes.every(isChange))) {
        throw new Refusal(
          `The artifact ${artifactId} holds no change set this version of the app can read, so its run cannot be accepted. Generate the run again.`
        );
      }
      return changes;
    },
    async saveProject(artifactId, name, text) {
      const entries: EntryInputs = {
        [PROJECT_FILE]: { bytes: text, mime: JSON_MIME },
      };
      if (artifactId === undefined) {
        const made = await artifacts.create({
          entries,
          metadata: { entry: PROJECT_FILE },
          name,
          type: TYPE.project,
        });
        return made.id;
      }
      const id = artifactIdOf(artifactId);
      await artifacts.write({ artifactId: id, changes: { put: entries } });
      const artifact = await artifacts.get(id);
      if (artifact && artifact.name !== name) {
        await artifacts.rename(id, name);
      }
      return artifactId;
    },
  };
};
