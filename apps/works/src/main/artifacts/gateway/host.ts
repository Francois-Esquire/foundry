import {
  type ArtifactResolved,
  type Artifacts,
  artifactIdSchema,
  type Content,
  isUsableContent,
} from "@foundry/artifacts";
import type { ModulePrincipal } from "@foundry/modules/gateway/types";
import { ModuleGatewayError } from "@foundry/modules/gateway/types";
import { ModuleSettingsError } from "@foundry/modules/settings";
import type { ModuleStore } from "@foundry/modules/store/contract";
import { authorizeRuntime, type RequiredGrant } from "~/main/gateway/authority";
import { denied } from "~/main/gateway/provider-kit";
import {
  type EditorBinding,
  EditorBindingDenied,
  type EditorBindings,
} from "../bindings";
import {
  type FileAuthority,
  FileWriteDenied,
  isProductArtifact,
  type ProductFiles,
} from "../files";

/** Works' Artifact operations for Module Programs (spec §7), all version 1. */
export const ARTIFACT_CAPABILITIES = {
  binding: "works.editors.binding",
  create: "works.artifacts.create",
  list: "works.artifacts.list",
  read: "works.artifacts.read",
  save: "works.artifacts.save",
  watch: "works.artifacts.watch",
} as const;

/** One Module's effective `artifacts.*` and `explorer.pageSize` settings. */
export interface ArtifactLimits {
  readonly chunkBytes: number;
  readonly maxFileBytes: number;
  /** Items in one page of `works.artifacts.list` (`explorer.pageSize`). */
  readonly pageSize: number;
}

/** What the providers act on: the shared manager and Works' services. */
export interface ArtifactHost {
  readonly artifacts: Pick<
    Artifacts,
    "get" | "getContent" | "list" | "observe" | "readFile" | "readFileRange"
  >;
  readonly bindings: EditorBindings;
  readonly files: ProductFiles;
  /** Each Module's effective limits. */
  readonly limits: (moduleId: string) => Promise<ArtifactLimits>;
  /** The Artifact-backed ModuleStore over the same manager. */
  readonly modules: Pick<
    ModuleStore,
    "loadGatewayContext" | "loadRetainedManifest"
  >;
}

export function resolveBinding(
  host: Pick<ArtifactHost, "bindings">,
  principal: ModulePrincipal,
  id: string
): EditorBinding {
  try {
    return host.bindings.resolve(principal, id);
  } catch (error) {
    if (error instanceof EditorBindingDenied) {
      throw denied(error.message);
    }
    throw error;
  }
}

/**
 * The runtime's authority as a write's own check, run inside its
 * transaction: a revoke that committed first refuses the write, and so does
 * `check` against the Artifact as the write found it.
 */
export function fileAuthority(
  host: Pick<ArtifactHost, "modules">,
  principal: ModulePrincipal,
  grants: readonly RequiredGrant[],
  check: (artifact: ArtifactResolved | null) => void = () => undefined,
  signal?: AbortSignal
): FileAuthority {
  return async (_operations, artifact) => {
    if (signal?.aborted) {
      throw new FileWriteDenied("The request was cancelled");
    }
    try {
      await authorizeRuntime(host.modules, principal, grants);
    } catch (error) {
      throw error instanceof ModuleGatewayError
        ? new FileWriteDenied(error.message)
        : error;
    }
    check(artifact);
  };
}

/** The entry at `path`, as `content` holds it. */
export function entryOf(
  content: Pick<Content, "state" | "tree"> | null | undefined,
  path: string
) {
  const node =
    content && isUsableContent(content) && Object.hasOwn(content.tree, path)
      ? content.tree[path]
      : undefined;
  return node?.type === "file"
    ? { bytes: node.bytes, digest: node.digest, mime: node.mime, path }
    : null;
}

/** A product Artifact that is not archived, by an id from the guest. */
export async function loadArtifact(
  host: Pick<ArtifactHost, "artifacts">,
  id: string
) {
  const parsed = artifactIdSchema.safeParse(id);
  const artifact = parsed.success
    ? await host.artifacts.get(parsed.data)
    : null;
  return artifact && isProductArtifact(artifact) && artifact.archivedAt === null
    ? artifact
    : null;
}

/**
 * The Module's effective limits. A Module whose settings cannot be resolved
 * is refused, never served the host defaults in their place.
 */
export async function limitsOf(
  host: Pick<ArtifactHost, "limits">,
  moduleId: string
): Promise<ArtifactLimits> {
  try {
    return await host.limits(moduleId);
  } catch (error) {
    if (error instanceof ModuleSettingsError) {
      throw denied(
        "This Module's settings have unmet requirements; review them in its settings"
      );
    }
    throw error;
  }
}
