import {
  type ArtifactResolved,
  type Artifacts,
  artifactIdSchema,
  type Content,
  isUsableContent,
} from "@foundry/artifacts";
import type { ModulePrincipal } from "@foundry/modules/gateway/types";
import { ModuleGatewayError } from "@foundry/modules/gateway/types";
import type { ModuleCommands } from "@foundry/modules/registry";
import { ModuleSettingsError } from "@foundry/modules/settings";
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

export const ARTIFACT_CAPABILITIES = {
  binding: "works.editors.binding",
  create: "works.artifacts.create",
  list: "works.artifacts.list",
  read: "works.artifacts.read",
  save: "works.artifacts.save",
  watch: "works.artifacts.watch",
} as const;

export interface ArtifactLimits {
  readonly chunkBytes: number;
  readonly maxFileBytes: number;
  readonly pageSize: number;
}

export interface ArtifactHost {
  readonly artifacts: Pick<
    Artifacts,
    "get" | "getContent" | "list" | "observe" | "readFile" | "readFileRange"
  >;
  readonly bindings: EditorBindings;
  readonly files: ProductFiles;
  readonly limits: (moduleId: string) => Promise<ArtifactLimits>;
  readonly modules: Pick<
    ModuleCommands,
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
