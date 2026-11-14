import { contentIdSchema, isUsableContent } from "@foundry/artifacts";
import {
  ModuleGatewayError,
  type ModulePrincipal,
} from "@foundry/modules/gateway/types";
import { authorizeRuntime } from "~/main/gateway/authority";
import {
  defineStream,
  defineUnary,
  denied,
  type WorksCapability,
} from "~/main/gateway/provider-kit";
import type { EditorBinding } from "../bindings";
import { FileWriteDenied, readRange } from "../files";
import {
  bindingInput,
  bindingOnly,
  bindingOutput,
  createInput,
  createOutput,
  createPolicy,
  FILE_MAX_BYTES,
  listInput,
  listOutput,
  readInput,
  readOutput,
  saveInput,
  saveOutput,
  watchEvent,
  watchInput,
} from "./contract";
import {
  ARTIFACT_CAPABILITIES,
  type ArtifactHost,
  entryOf,
  fileAuthority,
  limitsOf,
  loadArtifact,
  resolveBinding,
} from "./host";
import {
  ArtifactScopes,
  broaderScope,
  listPolicy,
  listScope,
  scopedEntry,
} from "./scope";
import { watchEntry, watchTarget } from "./watch";

function moduleActor(principal: ModulePrincipal) {
  return {
    installationId: principal.installationId,
    kind: "module" as const,
    moduleId: principal.moduleId,
    runtimeInstanceId: principal.runtimeInstanceId,
  };
}

/** Revoking a binding Grant closes the Installation's editor bindings. */
function closesBindings(host: ArtifactHost) {
  return ({ installationId }: { readonly installationId: string }) =>
    host.bindings.invalidate(installationId);
}

/**
 * A binding as its reads and saves see it: the entry of the Content it is
 * pinned to, even once the Artifact has moved on to newer Content (the
 * guest refreshes to follow it).
 */
async function describeBinding(host: ArtifactHost, binding: EditorBinding) {
  const artifact = await loadArtifact(host, binding.artifactId);
  const pinned =
    artifact?.contentId === binding.contentId
      ? artifact.content
      : await pinnedContent(host, binding);
  const entry = entryOf(pinned, binding.entry);
  if (!(artifact && pinned && entry)) {
    throw denied("This file is no longer available");
  }
  return {
    artifactId: artifact.id,
    binding: binding.id,
    contentId: binding.contentId,
    entry,
    mode: binding.mode,
    name: artifact.name,
    updatedAt: pinned.updatedAt.toISOString(),
  };
}

/** The Content a binding is pinned to, if it is still its Artifact's. */
async function pinnedContent(host: ArtifactHost, binding: EditorBinding) {
  const parsed = contentIdSchema.safeParse(binding.contentId);
  const content = parsed.success
    ? await host.artifacts.getContent(parsed.data)
    : null;
  return content?.artifactId === binding.artifactId ? content : null;
}

/**
 * The Content a refreshed binding moves to: the Artifact's active one, or
 * for a write binding its ready working successor, as opening for writing
 * binds (a frozen version is revised once), so the next save lands.
 */
async function refreshedContent(
  host: ArtifactHost,
  binding: EditorBinding
): Promise<string> {
  const artifact = await loadArtifact(host, binding.artifactId);
  if (!(artifact?.contentId && isUsableContent(artifact.content))) {
    throw denied("This file is no longer available");
  }
  if (binding.mode !== "write") {
    return artifact.contentId;
  }
  const working = await host.files.working(artifact.id);
  if (working === null) {
    throw denied("This file is no longer available");
  }
  return working;
}

function bindingCapability(host: ArtifactHost): WorksCapability {
  const capability = ARTIFACT_CAPABILITIES.binding;
  return defineUnary({
    capability,
    documentation:
      "Resolve an editor binding this app was opened with (or created): the Artifact, its Content, the entry and the access mode. `refresh` moves the binding to the Artifact's newer Content.",
    input: bindingInput,
    async invoke(request, { principal }) {
      let binding = resolveBinding(host, principal, request.binding);
      if (request.refresh) {
        binding = host.bindings.refresh(
          binding,
          await refreshedContent(host, binding)
        );
      }
      return describeBinding(host, binding);
    },
    output: bindingOutput,
    policy: bindingOnly(capability),
    revoked: closesBindings(host),
  });
}

/** The Content and entry a read names: through its binding, or in scope. */
async function readTarget(
  host: ArtifactHost,
  principal: ModulePrincipal,
  request: { artifactId?: string; binding?: string; path?: string }
): Promise<{ contentId: string; path: string }> {
  if (request.binding !== undefined) {
    const binding = resolveBinding(host, principal, request.binding);
    return { contentId: binding.contentId, path: binding.entry };
  }
  const { contentId, entry } = await scopedEntry(
    host,
    principal,
    request.artifactId ?? "",
    request.path
  );
  return { contentId, path: entry.path };
}

function readCapability(host: ArtifactHost): WorksCapability {
  const capability = ARTIFACT_CAPABILITIES.read;
  return defineUnary({
    capability,
    documentation:
      "Read the bound entry in bounded chunks (the Module's `artifacts.chunkBytes`). Pass `next` as `offset` until it is null. With an approved broader scope (works.artifacts.list), name an `artifactId` (and `path`) it covers instead of a binding.",
    input: readInput,
    async invoke(request, { principal }) {
      const target = await readTarget(host, principal, request);
      const { chunkBytes } = await limitsOf(host, principal.moduleId);
      const offset = request.offset ?? 0;
      const chunk = await readRange(
        host.artifacts,
        target.contentId,
        target.path,
        { end: offset + chunkBytes, start: offset }
      );
      if (!chunk) {
        throw denied("This file is no longer available");
      }
      return {
        bytes: chunk.bytes,
        data: Buffer.from(chunk.data).toString("base64"),
        digest: chunk.digest,
        mime: chunk.mime,
        next: chunk.end < chunk.bytes ? chunk.end : null,
        offset: chunk.offset,
      };
    },
    output: readOutput,
    policy: bindingOnly(capability),
    revoked: closesBindings(host),
  });
}

function saveCapability(host: ArtifactHost): WorksCapability {
  const capability = ARTIFACT_CAPABILITIES.save;
  return defineUnary({
    capability,
    documentation:
      "Save the bound entry's full text in place, fenced by the digest it was read at. `request` names this change: resending it returns the first answer, and reusing it for other text is refused. A conflict writes nothing and returns the saved entry. The text is limited to the Module's `artifacts.maxFileBytes` (UTF-8) and, being sent whole, to one Gateway frame (1 MiB).",
    input: saveInput,
    async invoke(request, { principal, signal }, { digest }) {
      const binding = resolveBinding(host, principal, request.binding);
      if (binding.mode !== "write") {
        throw denied("This file was opened read-only");
      }
      const { maxFileBytes } = await limitsOf(host, principal.moduleId);
      if (
        Buffer.byteLength(request.text, "utf8") >
        Math.min(maxFileBytes, FILE_MAX_BYTES)
      ) {
        throw new ModuleGatewayError(
          "invalid-input",
          "The file is larger than this Module may save"
        );
      }
      return await host.files.save({
        actor: moduleActor(principal),
        artifactId: binding.artifactId,
        authorize: fileAuthority(
          host,
          principal,
          [{ capability, digest }],
          (artifact) => {
            if (!host.bindings.current(binding)) {
              throw new FileWriteDenied("This editor binding was closed");
            }
            if (artifact?.contentId !== binding.contentId) {
              throw new FileWriteDenied(
                "This file was replaced by newer content; refresh it first"
              );
            }
          },
          signal
        ),
        expectedDigest: request.expectedDigest,
        path: binding.entry,
        request: request.request,
        ...(request.retry === undefined ? {} : { retry: request.retry }),
        text: request.text,
      });
    },
    output: saveOutput,
    policy: bindingOnly(capability),
    revoked: closesBindings(host),
  });
}

function createCapability(host: ArtifactHost): WorksCapability {
  const capability = ARTIFACT_CAPABILITIES.create;
  return defineUnary({
    capability,
    documentation:
      "Create a File Artifact with one primary entry in the local product store, and get a binding to read and save it. Allowed MIME types and the decoded size limit are the approved constraints `{ mimeTypes, maxBytes }`; reading and saving must be approved too.",
    input: createInput,
    async invoke(request, { principal }, { digest, value: constraints }) {
      if (!constraints.mimeTypes.includes(request.mime)) {
        throw denied(`Creating ${request.mime} files is not approved`);
      }
      const bytes = Buffer.from(
        request.content,
        request.encoding === "base64" ? "base64" : "utf8"
      );
      const { maxFileBytes } = await limitsOf(host, principal.moduleId);
      if (bytes.byteLength > Math.min(constraints.maxBytes, maxFileBytes)) {
        throw new ModuleGatewayError(
          "invalid-input",
          "The file is larger than this Module may create"
        );
      }
      const grants = [
        { capability, digest },
        ...[ARTIFACT_CAPABILITIES.read, ARTIFACT_CAPABILITIES.save].map(
          (bound) => ({
            capability: bound,
            digest: bindingOnly(bound).resolve(null).digest,
          })
        ),
      ];
      const created = await host.files.create({
        actor: moduleActor(principal),
        authorize: fileAuthority(host, principal, grants),
        bytes,
        mime: request.mime,
        name: request.name,
        path: request.path,
        request: request.request,
      });
      if (created.kind !== "created") {
        throw denied(created.reason);
      }
      if (created.retried) {
        // A retry remints a binding only for a runtime authorized now.
        await authorizeRuntime(host.modules, principal, grants);
      }
      const binding = host.bindings.open(
        {
          artifactId: created.artifactId,
          contentId: created.contentId,
          entry: created.path,
          installationId: principal.installationId,
          mode: "write",
          moduleId: principal.moduleId,
          release: principal.contentId,
          view: null,
        },
        principal
      );
      return {
        artifactId: created.artifactId,
        binding: binding.id,
        bytes: created.bytes,
        contentId: created.contentId,
        digest: created.digest,
        mode: "write",
        path: created.path,
        retried: created.retried,
        updatedAt: created.updatedAt,
      };
    },
    output: createOutput,
    policy: createPolicy,
  });
}

function watchCapability(
  host: ArtifactHost,
  scopes: ArtifactScopes
): WorksCapability {
  const capability = ARTIFACT_CAPABILITIES.watch;
  return defineStream({
    capability,
    documentation:
      "Watch the bound entry: a snapshot, then each committed change and its removal. File bodies are read with works.artifacts.read. On reconnect pass the last state you saw as `after`: the snapshot reports a gap if it moved, without replaying what was missed. With an approved broader scope (works.artifacts.list), name an `artifactId` (and `path`) it covers instead of a binding.",
    event: watchEvent,
    input: watchInput,
    async *invoke(request, { principal, signal }) {
      const target = await watchTarget(host, scopes, principal, request);
      yield* watchEntry(host, target, request.after, signal);
    },
    policy: bindingOnly(capability),
  });
}

function listCapability(
  host: ArtifactHost,
  scopes: ArtifactScopes
): WorksCapability {
  return defineUnary({
    capability: ARTIFACT_CAPABILITIES.list,
    documentation:
      "List the product Artifacts of the types the approved constraints `{ types: [\"text/markdown\"] }` name, a page (the Module's `explorer.pageSize`) at a time. That approval is this Module's broader scope: works.artifacts.read and works.artifacts.watch then also take an `artifactId` it covers.",
    input: listInput,
    async invoke(request, { principal }) {
      const scope = await broaderScope(host, principal);
      if (!scope) {
        throw denied("Listing Artifacts is not approved");
      }
      const { pageSize } = await limitsOf(host, principal.moduleId);
      return listScope(host, scope, pageSize, request.cursor);
    },
    output: listOutput,
    policy: listPolicy,
    // Broader-scope watches end with the scope.
    revoked: ({ installationId }) => scopes.revoke(installationId),
    scope: { area: "artifacts", of: ({ types }) => types },
  });
}

/**
 * The six Artifact capabilities over `host`. Revoking a binding Grant
 * closes the Installation's editor bindings; revoking the list Grant ends
 * its broader-scope watches.
 */
export function artifactCapabilities(host: ArtifactHost): WorksCapability[] {
  const scopes = new ArtifactScopes();
  return [
    bindingCapability(host),
    readCapability(host),
    saveCapability(host),
    createCapability(host),
    watchCapability(host, scopes),
    listCapability(host, scopes),
  ];
}
