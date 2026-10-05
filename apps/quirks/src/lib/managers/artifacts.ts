import { createHash } from "node:crypto";
import type {
  ArtifactId,
  Artifacts as ArtifactStore,
  FileInputs,
} from "@foundry/artifacts";
import { artifactIdSchema } from "@foundry/artifacts";
import { classifyFile } from "@foundry/lib/file-classification";

import type { ManagerArgs } from "../bindings";
import type {
  ArtifactDefinition,
  ArtifactFiles,
  Artifacts,
  ArtifactVersion,
} from "../types";

/**
 * Versioned outputs over the shared artifact store. A declared artifact
 * keeps its identity across runs, so each write adds a version instead of
 * a new artifact. Called on the manager, a write is just that. Through a
 * step's view, the n-th write in a body returns the version it created the
 * first time.
 */

export interface ArtifactsDeps {
  readonly artifacts: Pick<ArtifactStore, "create" | "get" | "revise">;
  /** Part of a declared artifact's identity, so two configs never collide. */
  readonly workspaceId: string;
}

const KIND = "artifacts.write";
const ID_LENGTH = 24;

/** Provisional identity: the workspace and the declared name. */
export function artifactIdFor(workspaceId: string, name: string): ArtifactId {
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${name}`)
    .digest("hex")
    .slice(0, ID_LENGTH);
  return artifactIdSchema.parse(`artifact-${digest}`);
}

function entriesOf(files: ArtifactFiles, fallbackMime?: string): FileInputs {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      {
        bytes:
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content,
        mime: classifyFile(path).mime ?? fallbackMime ?? null,
      },
    ])
  );
}

function versionOf(artifactId: string, contentId: string): ArtifactVersion {
  return { artifactId, contentId, id: `${artifactId}:${contentId}` };
}

export class ArtifactsManager implements Artifacts {
  readonly #deps: ArtifactsDeps;

  constructor(deps: ArtifactsDeps) {
    this.#deps = deps;
  }

  async create({
    name,
    type,
    entries,
  }: Parameters<Artifacts["create"]>[0]): Promise<ArtifactVersion> {
    const created = await this.#deps.artifacts.create({
      ...(entries === undefined ? {} : { entries: entriesOf(entries, type) }),
      name,
      type,
    });
    if (!created.content) {
      throw new Error(`artifact "${name}" was created without content`);
    }
    return versionOf(created.id, created.content.id);
  }

  /** Adds a version to the declared artifact, creating it the first time. */
  async write(
    definition: ArtifactDefinition,
    files: ArtifactFiles
  ): Promise<ArtifactVersion> {
    const { artifacts, workspaceId } = this.#deps;
    const id = artifactIdFor(workspaceId, definition.name);
    const existing = await artifacts.get(id);
    const entries = entriesOf(files, definition.type);
    if (existing === null) {
      const created = await artifacts.create({
        entries,
        id,
        name: definition.name,
        type: definition.type,
      });
      if (!created.content) {
        throw new Error(`artifact "${definition.name}" has no content`);
      }
      return versionOf(id, created.content.id);
    }
    if (!existing.content) {
      throw new Error(`artifact "${definition.name}" has no content`);
    }
    const revised = await artifacts.revise({
      artifactId: id,
      changes: { put: entries, replace: true },
      contentId: existing.content.id,
      expectedUpdatedAt: existing.content.updatedAt,
    });
    return versionOf(id, revised.id);
  }

  /** What a step body sees: writes counted against its frame, so a replay returns the same version. */
  scoped({ frame, scope }: ManagerArgs): Artifacts {
    return {
      create: (input) => this.create(input),
      write: async (definition, files) => {
        const { key } = scope.claim(frame, KIND);
        const recorded = scope.ledger.get<ArtifactVersion>(key);
        if (recorded) {
          return recorded;
        }
        const version = await this.write(definition, files);
        scope.ledger.set(key, version);
        return version;
      },
    };
  }
}
