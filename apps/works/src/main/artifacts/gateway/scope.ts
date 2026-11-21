import {
  type ArtifactResolved,
  artifactIdSchema,
  isUsableContent,
  rootPath,
} from "@foundry/artifacts";
import {
  ModuleGatewayError,
  type ModulePrincipal,
} from "@foundry/modules/gateway/types";
import { isGranted } from "@foundry/modules/grants";
import { MIME_TYPE_PATTERN } from "@foundry/modules/manifest";
import { embeddedManifest } from "@foundry/modules/version";
import { z } from "zod";
import { authorizeRuntime } from "~/main/gateway/authority";
import { constrained, denied } from "~/main/gateway/provider-kit";
import { isProductArtifact } from "../files";
import {
  ARTIFACT_CAPABILITIES,
  type ArtifactHost,
  entryOf,
  loadArtifact,
} from "./host";

const listConstraints = z
  .object({
    types: z.array(z.string().regex(MIME_TYPE_PATTERN)).min(1).max(32),
  })
  .strict();

export const listPolicy = constrained(ARTIFACT_CAPABILITIES.list, (raw) => {
  const types = [...new Set(listConstraints.parse(raw).types)].sort();
  if (types.some((type) => !isProductArtifact({ type }))) {
    throw new Error("Module Artifacts are never in a Module's scope");
  }
  return { types };
});

export class ArtifactScopes {
  readonly #revocations = new Map<string, AbortController>();

  signal(installationId: string): AbortSignal {
    let controller = this.#revocations.get(installationId);
    if (!controller) {
      controller = new AbortController();
      this.#revocations.set(installationId, controller);
    }
    return controller.signal;
  }

  revoke(installationId: string): void {
    this.#revocations.get(installationId)?.abort();
    this.#revocations.delete(installationId);
  }
}

export async function broaderScope(
  host: Pick<ArtifactHost, "artifacts" | "modules">,
  principal: ModulePrincipal
): Promise<readonly string[] | null> {
  const context = await authorizeRuntime(host.modules, principal, []).catch(
    (error: unknown) => {
      if (error instanceof ModuleGatewayError) {
        return null;
      }
      throw error;
    }
  );
  if (!context) {
    return null;
  }
  const manifest =
    (await host.modules.loadRetainedManifest(principal.contentId)) ??
    (await embeddedManifest(host.artifacts, principal.contentId).catch(
      () => null
    ));
  const request = manifest?.capabilities.find(
    (candidate) =>
      candidate.capability === ARTIFACT_CAPABILITIES.list &&
      candidate.version === 1
  );
  if (!request) {
    return null;
  }
  let policy: ReturnType<typeof listPolicy.resolve>;
  try {
    policy = listPolicy.resolve(request.constraints ?? null);
  } catch {
    return null;
  }
  return isGranted(context.grants, {
    capability: ARTIFACT_CAPABILITIES.list,
    constraintsDigest: policy.digest,
    version: 1,
  })
    ? policy.value.types
    : null;
}

function inScope(
  scope: readonly string[],
  artifact: Pick<ArtifactResolved, "type">
): boolean {
  return scope.includes(artifact.type.toLowerCase());
}

const notInScope = () => denied("This Artifact is not available to this app");

export function scopedPath(
  scope: readonly string[],
  artifact: ArtifactResolved | null,
  path: string | undefined
): string | null {
  const content = artifact?.content;
  if (!(artifact && content && isUsableContent(content))) {
    return null;
  }
  if (!inScope(scope, artifact)) {
    return null;
  }
  return path ?? rootPath(content);
}

export async function scopedEntry(
  host: Pick<ArtifactHost, "artifacts" | "modules">,
  principal: ModulePrincipal,
  artifactId: string,
  path: string | undefined
) {
  const scope = await broaderScope(host, principal);
  const artifact = scope ? await loadArtifact(host, artifactId) : null;
  const entryPath = scope ? scopedPath(scope, artifact, path) : null;
  const entry =
    entryPath === null ? null : entryOf(artifact?.content, entryPath);
  if (!(scope && artifact?.contentId && entry)) {
    throw notInScope();
  }
  return { artifact, contentId: artifact.contentId, entry, scope };
}

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.string() });

function encodeCursor(artifact: ArtifactResolved): string {
  return Buffer.from(
    JSON.stringify({ at: artifact.createdAt.toISOString(), id: artifact.id })
  ).toString("base64url");
}

function decodeCursor(cursor: string) {
  let raw: unknown = null;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    // Not JSON: refused below like any other malformed cursor.
  }
  const parsed = cursorSchema.safeParse(raw);
  const id = parsed.success ? artifactIdSchema.safeParse(parsed.data.id) : null;
  if (!(parsed.success && id?.success)) {
    throw new ModuleGatewayError("invalid-input", "The cursor is invalid");
  }
  return { createdAt: new Date(parsed.data.at), id: id.data };
}

function listed(artifact: ArtifactResolved) {
  const { content } = artifact;
  const path = content && isUsableContent(content) ? rootPath(content) : null;
  return {
    artifactId: artifact.id,
    contentId: artifact.contentId,
    entry: path === null ? null : entryOf(artifact.content, path),
    name: artifact.name,
    type: artifact.type,
    updatedAt: (content?.updatedAt ?? artifact.updatedAt).toISOString(),
  };
}

export async function listScope(
  host: Pick<ArtifactHost, "artifacts">,
  scope: readonly string[],
  pageSize: number,
  cursor: string | undefined
) {
  const items: ArtifactResolved[] = [];
  let position = cursor === undefined ? undefined : decodeCursor(cursor);
  for (;;) {
    const page = await host.artifacts.list({
      limit: pageSize,
      ...(position === undefined ? {} : { cursor: position }),
      ...(scope.length === 1 ? { type: scope[0] } : {}),
    });
    for (const artifact of page.items) {
      if (isProductArtifact(artifact) && inScope(scope, artifact)) {
        items.push(artifact);
        if (items.length === pageSize) {
          return { items: items.map(listed), next: encodeCursor(artifact) };
        }
      }
    }
    if (page.nextCursor === undefined) {
      return { items: items.map(listed), next: null };
    }
    position = page.nextCursor;
  }
}
