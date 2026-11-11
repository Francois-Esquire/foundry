/**
 * The application: one open project and everything that can be done to it,
 * with no screen. A command runs the same use case its place's screen runs,
 * and says what it did in plain data. A command that will not do what it was
 * asked throws a `Refusal`.
 */
import type { Verdict } from "~/generation/evaluation/evaluation";
import { reasonOf } from "~/lib/reason";
import { Refusal } from "~/lib/refusal";
import type { FaceId, SourceId } from "~/typeface/face";
import { createWorkspace, type Workspace } from "~/workspace/workspace";
import { accept } from "./accepting";
import type {
  Accepted,
  AcceptRequest,
  CandidateRun,
  CandidateRunRequest,
  Exported,
  ExportRequest,
  ExtensionRun,
  ExtensionRunRequest,
  Reconstructed,
  ReconstructRequest,
  Rendered,
  RenderRequest,
} from "./commands";
import { exportFonts } from "./exporting";
import { generateCandidates, generateExtension } from "./generating";
import { importFiles } from "./importing";
import { inspect } from "./inspecting";
import type { ApplicationMeans } from "./means";
import type { OpenProject } from "./open-project";
import { type Places, placesOf } from "./places";
import {
  type Kept,
  NOTHING_KEPT,
  readProjectFile,
  type WaitingRun,
  writeProjectFile,
} from "./project-file";
import { reconstruct } from "./reconstructing";
import { render } from "./rendering";
import { stamping } from "./stamping";
import { createStore, type KeptExport } from "./store";

/**
 * Runs a command that is a place's operations in order. Whatever stops one
 * of them is a sentence the place's screen shows, whether the operation
 * refused or something beneath it failed, so from the command it is a
 * refusal with that sentence.
 */
const refusing = async <Result>(
  command: () => Promise<Result>
): Promise<Result> => {
  try {
    return await command();
  } catch (error) {
    throw error instanceof Refusal
      ? error
      : new Refusal(reasonOf(error), { cause: error });
  }
};

/** A file handed to `import`: a font, or a photograph of lettering. */
export interface GivenFile {
  readonly bytes: Uint8Array;
  readonly name: string;
}

export interface ImportedFont {
  /** True when the project already held this file, under this name or another. */
  readonly alreadyImported: boolean;
  /** The artifact that holds the file, byte for byte. */
  readonly artifactId: string;
  readonly faces: readonly {
    readonly faceId: FaceId;
    readonly label: string;
  }[];
  readonly fileName: string;
}

export interface ImportedPhotograph {
  readonly alreadyImported: boolean;
  readonly artifactId: string;
  readonly fileName: string;
}

export interface Imported {
  readonly fonts: readonly ImportedFont[];
  readonly photographs: readonly ImportedPhotograph[];
  /** Files that are neither, each with the reason. The others are still imported. */
  readonly refused: readonly {
    readonly name: string;
    readonly reason: string;
  }[];
}

/** What a face covers of one script, or of one group of characters scripts share. */
export interface ScriptCoverage {
  /** Characters only a waiting candidate offers. */
  readonly candidates: number;
  /** Characters the face can set: from its source, edited or added. */
  readonly covered: number;
  readonly name: string;
  /** The ISO 15924 code, for example Deva. Absent for a shared group. */
  readonly script?: string;
  readonly total: number;
}

export interface InspectedFace {
  /**
   * Every script and shared group the face touches, the best covered first,
   * then each script an extension is planned for that the face lacks.
   */
  readonly coverage: readonly ScriptCoverage[];
  /** False for a variable face, which is pinned to an instance before it takes changes. */
  readonly editable: boolean;
  readonly faceId: FaceId;
  /** What a command takes in place of the face id. */
  readonly label: string;
  /** The artifact that holds the face's source font, once it is kept. */
  readonly sourceFont?: string;
}

/** A candidate waiting for a decision. */
export interface WaitingCandidate {
  readonly faceId: FaceId;
  readonly id: string;
  readonly name: string;
  readonly origin: "generated" | "manual" | "reconstructed";
  /** The characters it draws. Empty for a form only layout reaches. */
  readonly text: string;
  /** The verdict its run gave it. Traced lettering has none. */
  readonly verdict?: Verdict;
}

/** What the project holds now. */
export interface Inspection {
  readonly exports: readonly KeptExport[];
  readonly faces: readonly InspectedFace[];
  readonly name: string;
  readonly photographs: readonly {
    readonly artifactId: string;
    readonly fileName: string;
  }[];
  /** How many revisions are applied. */
  readonly revisions: number;
  readonly waiting: {
    readonly candidates: readonly WaitingCandidate[];
    readonly runs: readonly WaitingRun[];
  };
}

export interface Application {
  accept(request: AcceptRequest): Promise<Accepted>;
  /** Closes the fonts the project holds open. Unsaved work is lost: save first. */
  close(): Promise<void>;
  export(request: ExportRequest): Promise<Exported>;
  generate(request: ExtensionRunRequest): Promise<ExtensionRun>;
  generate(request: CandidateRunRequest): Promise<CandidateRun>;
  import(files: readonly GivenFile[]): Promise<Imported>;
  inspect(): Inspection;
  readonly places: Places;
  reconstruct(request: ReconstructRequest): Promise<Reconstructed>;
  render(request: RenderRequest): Promise<Rendered>;
  /** Writes the project file in place, and keeps any source font not kept yet. */
  save(): Promise<void>;
  readonly workspace: Workspace;
}

/**
 * Opens the project kept in the artifact `project`, or an empty one. A
 * project opens as it was saved: nothing is replayed with new ids or times.
 */
export const openApplication = async (
  given: ApplicationMeans,
  project?: string
): Promise<Application> => {
  const means: ApplicationMeans = {
    ...given,
    builder: stamping(given.builder, given.clock),
  };
  const store = createStore(means.artifacts);
  const opened =
    project === undefined
      ? undefined
      : await readProjectFile(await store.readProject(project), (artifactId) =>
          store.read({ artifactId })
        );
  const workspace = createWorkspace({
    activeFaceId: opened?.activeFaceId,
    clock: means.clock,
    newId: means.newId,
    project: opened?.project,
    reader: means.reader,
  });
  const sourceArtifacts = new Map<SourceId, string>(opened?.sourceArtifacts);
  let kept: Kept = opened?.kept ?? NOTHING_KEPT;
  let exports: readonly KeptExport[] = await store.exports();
  let projectArtifact = project;
  let closed = false;

  const keptArtifact = (sourceId: SourceId): string => {
    const artifactId = sourceArtifacts.get(sourceId);
    if (artifactId === undefined) {
      throw new Error(`The source font ${sourceId} was not kept.`);
    }
    return artifactId;
  };

  const open: OpenProject = {
    exports: () => exports,
    keep(patch) {
      kept = { ...kept, ...patch };
    },
    async keepSources() {
      for (const source of workspace.getState().project.sources) {
        if (!sourceArtifacts.has(source.id)) {
          sourceArtifacts.set(
            source.id,
            await store.keepSourceFont({
              bytes: source.bytes,
              digest: source.id,
              fileName: source.fileName,
            })
          );
        }
      }
      return keptArtifact;
    },
    kept: () => kept,
    means,
    noteExport(noted) {
      exports = [
        ...exports.filter((known) => known.artifactId !== noted.artifactId),
        noted,
      ];
    },
    places: placesOf(means, workspace),
    sourceArtifact: (sourceId) => sourceArtifacts.get(sourceId),
    store,
    workspace,
  };

  /** A closed application has let go of its fonts, so it runs nothing more. */
  const whileOpen = <Result>(command: () => Result): Result => {
    if (closed) {
      throw new Refusal(
        "This application is closed. Open the project again to go on."
      );
    }
    return command();
  };

  async function generate(request: ExtensionRunRequest): Promise<ExtensionRun>;
  async function generate(request: CandidateRunRequest): Promise<CandidateRun>;
  async function generate(request: CandidateRunRequest | ExtensionRunRequest) {
    return await whileOpen(() =>
      refusing<CandidateRun | ExtensionRun>(() =>
        request.kind === "script-extension"
          ? generateExtension(open, request)
          : generateCandidates(open, request)
      )
    );
  }

  return {
    accept: async (request) => whileOpen(() => accept(open, request)),
    close() {
      if (!closed) {
        closed = true;
        workspace.close();
      }
      return Promise.resolve();
    },
    export: async (request) => whileOpen(() => exportFonts(open, request)),
    generate,
    import: async (files) => whileOpen(() => importFiles(open, files)),
    inspect: () => whileOpen(() => inspect(open)),
    places: open.places,
    reconstruct: async (request) =>
      whileOpen(() => refusing(() => reconstruct(open, request))),
    render: async (request) => whileOpen(() => render(open, request)),
    save: async () =>
      whileOpen(async () => {
        const artifactOf = await open.keepSources();
        const { activeFaceId, project: current } = workspace.getState();
        projectArtifact = await store.saveProject(
          projectArtifact,
          current.name,
          writeProjectFile({ activeFaceId, kept, project: current }, artifactOf)
        );
      }),
    workspace,
  };
};
