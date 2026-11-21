import type { ArtifactResolved } from "@foundry/artifacts";
import type { ModulePrincipal } from "@foundry/modules/gateway/types";
import { denied } from "~/main/gateway/provider-kit";
import { latest } from "~/main/platform/latest";
import {
  type ArtifactHost,
  entryOf,
  loadArtifact,
  resolveBinding,
} from "./host";
import {
  type ArtifactScopes,
  broaderScope,
  scopedEntry,
  scopedPath,
} from "./scope";

export interface WatchedEntry {
  readonly artifactId: string;
  readonly contentId: string | null;
  readonly entry: {
    readonly bytes: number;
    readonly digest: string;
    readonly mime: string | null;
    readonly path: string;
  } | null;
  readonly gap?: boolean;
  readonly kind: "change" | "removed" | "snapshot";
  readonly updatedAt: string | null;
}

type EntryState = Omit<WatchedEntry, "gap" | "kind">;

export interface WatchRequest {
  readonly artifactId?: string;
  readonly binding?: string;
  readonly path?: string;
}

interface WatchTarget {
  readonly artifactId: string;
  entry(artifact: ArtifactResolved): Promise<string | null>;
  readonly revoked?: AbortSignal;
  readonly signal?: AbortSignal;
}

const SCOPE_REVOKED = "Access to this Artifact was revoked";

export async function watchTarget(
  host: Pick<ArtifactHost, "artifacts" | "bindings" | "modules">,
  scopes: ArtifactScopes,
  principal: ModulePrincipal,
  request: WatchRequest
): Promise<WatchTarget> {
  if (request.binding !== undefined) {
    const binding = resolveBinding(host, principal, request.binding);
    return {
      artifactId: binding.artifactId,
      entry: () => Promise.resolve(binding.entry),
      signal: binding.signal,
    };
  }
  const revoked = scopes.signal(principal.installationId);
  const { artifact } = await scopedEntry(
    host,
    principal,
    request.artifactId ?? "",
    request.path
  );
  const { path } = request;
  return {
    artifactId: artifact.id,
    async entry(current) {
      const scope = await broaderScope(host, principal);
      if (!scope) {
        throw denied(SCOPE_REVOKED);
      }
      return scopedPath(scope, current, path);
    },
    revoked,
  };
}

async function watchedState(
  host: Pick<ArtifactHost, "artifacts">,
  target: WatchTarget
): Promise<EntryState> {
  const artifact = await loadArtifact(host, target.artifactId);
  const path = artifact ? await target.entry(artifact) : null;
  const entry = path === null ? null : entryOf(artifact?.content, path);
  return {
    artifactId: target.artifactId,
    contentId: entry ? (artifact?.contentId ?? null) : null,
    entry,
    updatedAt:
      entry && artifact?.content
        ? artifact.content.updatedAt.toISOString()
        : null,
  };
}

function sameState(
  left: Pick<WatchedEntry, "contentId" | "entry">,
  right: Pick<WatchedEntry, "contentId" | "entry">
): boolean {
  return (
    left.contentId === right.contentId &&
    left.entry?.digest === right.entry?.digest &&
    left.entry?.mime === right.entry?.mime
  );
}

export async function* watchEntry(
  host: Pick<ArtifactHost, "artifacts">,
  target: WatchTarget,
  after: { readonly contentId: string; readonly digest: string } | undefined,
  signal: AbortSignal
): AsyncGenerator<WatchedEntry, void> {
  const states = latest<EntryState>({
    read: () => watchedState(host, target),
    same: sameState,
    signal: AbortSignal.any(
      [signal, target.signal, target.revoked].filter(
        (candidate) => candidate !== undefined
      )
    ),
    subscribe: (changed) =>
      host.artifacts.observe((id) => {
        if (id === target.artifactId) {
          changed();
        }
      }),
  });
  let first = true;
  for await (const state of states) {
    if (!state.entry) {
      yield { ...state, kind: "removed" };
      return;
    }
    if (first) {
      first = false;
      yield {
        ...state,
        gap: after
          ? !sameState(state, {
              contentId: after.contentId,
              entry: { ...state.entry, digest: after.digest },
            })
          : false,
        kind: "snapshot",
      };
    } else {
      yield { ...state, kind: "change" };
    }
  }
  if (target.revoked?.aborted && !signal.aborted) {
    throw denied(SCOPE_REVOKED);
  }
}
