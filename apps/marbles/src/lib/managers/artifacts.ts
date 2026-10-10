import { createHash } from "node:crypto";
import type {
  ArtifactId,
  ArtifactOperations,
  Content,
  ContentResolved,
  FileInput,
  FileInputs,
} from "@foundry/artifacts";
import { artifactIdSchema, contentIdSchema } from "@foundry/artifacts";
import { classifyFile } from "@foundry/lib/file-classification";

import type { ManagerArgs } from "../bindings";
import type {
  ArtifactDefinition,
  ArtifactFiles,
  ArtifactRef,
  Artifacts,
  ArtifactVersion,
  ArtifactWriteOptions,
  LatestArtifact,
} from "../types";

/**
 * Versioned outputs over the shared artifact store. A declared artifact
 * keeps its identity across runs, so each write adds a version instead of
 * a new artifact. Called on the manager, a write is just that. Through a
 * step's view, the n-th write in a body returns the version it created the
 * first time.
 */

export interface ArtifactsDeps {
  readonly artifacts: Pick<
    ArtifactOperations,
    | "create"
    | "get"
    | "getContent"
    | "listContents"
    | "readFile"
    | "readRoot"
    | "revise"
  >;
  /**
   * Where `latest` also looks when `artifacts` has nothing: the real store
   * under `--dry-run`, whose own store is in memory. Only read.
   */
  readonly readThrough?: Pick<ArtifactOperations, "get" | "readFile">;
  /** Part of a declared artifact's identity, so two configs never collide. */
  readonly workspaceId: string;
}

const KIND = "artifacts.write";
const CREATE_KIND = "artifacts.create";
const ID_LENGTH = 24;

/** Provisional identity: the workspace and the declared name. */
export function artifactIdFor(workspaceId: string, name: string): ArtifactId {
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${name}`)
    .digest("hex")
    .slice(0, ID_LENGTH);
  return artifactIdSchema.parse(`artifact-${digest}`);
}

function isFileInput(
  value: string | Uint8Array | FileInput
): value is FileInput {
  return typeof value === "object" && !(value instanceof Uint8Array);
}

/** Text and bytes become file inputs with a MIME from the path; a file input passes as it is. */
function entriesOf(files: ArtifactFiles, fallbackMime?: string): FileInputs {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      isFileInput(content)
        ? content
        : {
            bytes:
              typeof content === "string"
                ? new TextEncoder().encode(content)
                : content,
            mime: classifyFile(path).mime ?? fallbackMime ?? null,
          },
    ])
  );
}

/** A version as Marbles hands it out: the package's Content, as JSON. */
function versionOf(content: Content): ArtifactVersion {
  const { artifact: _artifact, ...version } = content as ContentResolved;
  return JSON.parse(JSON.stringify(version)) as ArtifactVersion;
}

/** Who wrote a version: kept on its metadata, from the run that wrote it. */
type Provenance = Readonly<Record<string, unknown>>;

export class ArtifactsManager implements Artifacts {
  readonly #deps: ArtifactsDeps;

  constructor(deps: ArtifactsDeps) {
    this.#deps = deps;
  }

  /** The package id an artifact goes by: its declaration's, or the one given. */
  #idOf(artifact: ArtifactRef): ArtifactId {
    return typeof artifact === "string"
      ? artifactIdSchema.parse(artifact)
      : artifactIdFor(this.#deps.workspaceId, artifact.name);
  }

  create(input: Parameters<Artifacts["create"]>[0]): Promise<ArtifactVersion> {
    return this.#create(input, {});
  }

  async #create(
    {
      entries,
      freeze,
      metadata,
      name,
      type,
    }: Parameters<Artifacts["create"]>[0],
    provenance: Provenance
  ): Promise<ArtifactVersion> {
    const created = await this.#deps.artifacts.create({
      ...(entries === undefined ? {} : { entries: entriesOf(entries, type) }),
      ...(freeze === undefined ? {} : { freeze }),
      metadata: { ...provenance, ...metadata },
      name,
      type,
    });
    if (!created.content) {
      throw new Error(`artifact "${name}" was created without content`);
    }
    return versionOf(created.content);
  }

  write(
    definition: ArtifactDefinition,
    files: ArtifactFiles,
    options?: ArtifactWriteOptions
  ): Promise<ArtifactVersion> {
    return this.#write(definition, files, options, {});
  }

  /** Adds a version to the declared artifact, creating it the first time. */
  async #write(
    definition: ArtifactDefinition,
    files: ArtifactFiles,
    options: ArtifactWriteOptions | undefined,
    provenance: Provenance
  ): Promise<ArtifactVersion> {
    const { artifacts } = this.#deps;
    const id = this.#idOf(definition);
    const existing = await artifacts.get(id);
    const entries = entriesOf(files, definition.type);
    const metadata = { ...provenance, ...options?.metadata };
    if (existing === null) {
      const created = await artifacts.create({
        entries,
        id,
        metadata,
        name: definition.name,
        type: definition.type,
      });
      if (!created.content) {
        throw new Error(`artifact "${definition.name}" has no content`);
      }
      return versionOf(created.content);
    }
    if (!existing.content) {
      throw new Error(`artifact "${definition.name}" has no content`);
    }
    const revised = await artifacts.revise({
      artifactId: id,
      changes: { put: entries, replace: options?.replace ?? true },
      contentId: existing.content.id,
      expectedUpdatedAt: existing.content.updatedAt,
      metadata,
    });
    return versionOf(revised);
  }

  get(artifact: ArtifactRef) {
    return this.#deps.artifacts.get(this.#idOf(artifact));
  }

  getContent(versionId: string) {
    return this.#deps.artifacts.getContent(contentIdSchema.parse(versionId));
  }

  /** The current version from this store, else the read-through one. */
  async latest(artifact: ArtifactRef): Promise<LatestArtifact | undefined> {
    const id = this.#idOf(artifact);
    for (const source of [this.#deps.artifacts, this.#deps.readThrough]) {
      const found = await source?.get(id);
      if (source && found?.content) {
        const { content } = found;
        const bytes = async (path: string) =>
          (await source.readFile(content.id, path))?.blob;
        return {
          bytes,
          text: async (path) => {
            const read = await bytes(path);
            return read === undefined
              ? undefined
              : new TextDecoder().decode(read);
          },
          version: versionOf(content),
        };
      }
    }
  }

  listContents(artifact: ArtifactRef) {
    return this.#deps.artifacts.listContents(this.#idOf(artifact));
  }

  readFile(versionId: string, path: string) {
    return this.#deps.artifacts.readFile(
      contentIdSchema.parse(versionId),
      path
    );
  }

  readRoot(versionId: string) {
    return this.#deps.artifacts.readRoot(contentIdSchema.parse(versionId));
  }

  /**
   * What a step body sees: each version records the run and its session,
   * and writes and creates are counted against the frame, so a replay
   * returns the version it made instead of a second one. The ledger keeps
   * the version's id; a replay reads the version back.
   */
  scoped({ frame, scope }: ManagerArgs): Artifacts {
    const provenance: Provenance = {
      runId: scope.id,
      sessionId: scope.session.id,
    };
    const once = async (
      kind: string,
      make: () => Promise<ArtifactVersion>
    ): Promise<ArtifactVersion> => {
      const { key } = scope.claim(frame, kind);
      const recorded = scope.ledger.get<string>(key);
      if (typeof recorded === "string") {
        const found = await this.getContent(recorded);
        if (found) {
          return versionOf(found);
        }
      }
      const version = await make();
      scope.ledger.set(key, version.id);
      return version;
    };
    return {
      create: (input) =>
        once(CREATE_KIND, () => this.#create(input, provenance)),
      get: (artifact) => this.get(artifact),
      getContent: (versionId) => this.getContent(versionId),
      latest: (artifact) => this.latest(artifact),
      listContents: (artifact) => this.listContents(artifact),
      readFile: (versionId, path) => this.readFile(versionId, path),
      readRoot: (versionId) => this.readRoot(versionId),
      write: (definition, files, options) =>
        once(KIND, () => this.#write(definition, files, options, provenance)),
    };
  }
}
