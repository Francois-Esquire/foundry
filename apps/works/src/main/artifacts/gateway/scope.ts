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

/**
 * The broader Artifact scope: the product Artifact types (exact MIME,
 * lowercase) a Module may list, and read and watch beyond its bindings. The
 * approved `works.artifacts.list` Grant IS that scope; reading and watching
 * still need their own Grants. Without it a Module stays binding-only.
 */
export const listPolicy = constrained(ARTIFACT_CAPABILITIES.list, (raw) => {
  const types = [...new Set(listConstraints.parse(raw).types)].sort();
  if (types.some((type) => !isProductArtifact({ type }))) {
    throw new Error("Module Artifacts are never in a Module's scope");
  }
  return { types };
});

/**
 * Ends broader-scope reads in flight for an Installation whose list Grant
 * was revoked; each later request is checked against its Grants anyway.
 */
export class ArtifactScopes {
  readonly #revocations = new Map<string, AbortController>();

  /** Aborted when the Installation's broader scope is revoked. */
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

/**
 * The runtime's approved broader scope, read from host state on every call:
 * its Installation still running this release and holding a list Grant for
 * exactly what this release requests. `null` means binding-only.
 */
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
  // The release's own Manifest: retained by the store, else the frozen file.
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

/** The same answer for out of scope, archived, Module and unknown IDs. */
const notInScope = () => denied("This Artifact is not available to this app");

/** The entry `path` names, or the primary entry, of an Artifact in scope. */
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

/** An entry of an Artifact the caller's broader scope covers, or a refusal. */
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

// ── Listing ──

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

/**
 * One page (`explorer.pageSize`) of the product Artifacts the scope covers.
 * Only listed Artifacts ever shape the cursor, so nothing out of scope is
 * revealed, not even an id.
 */
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
