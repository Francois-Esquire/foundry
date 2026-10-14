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

/** The committed state of a watched entry, or its removal. */
export interface WatchedEntry {
  readonly artifactId: string;
  readonly contentId: string | null;
  readonly entry: {
    readonly bytes: number;
    readonly digest: string;
    readonly mime: string | null;
    readonly path: string;
  } | null;
  /** On a snapshot: changes were missed since `after` (history is not replayed). */
  readonly gap?: boolean;
  readonly kind: "change" | "removed" | "snapshot";
  readonly updatedAt: string | null;
}

type EntryState = Omit<WatchedEntry, "gap" | "kind">;

/** What a watch names: a binding, or an Artifact (and entry) in scope. */
export interface WatchRequest {
  readonly artifactId?: string;
  readonly binding?: string;
  readonly path?: string;
}

/**
 * What one watch follows: an Artifact, the entry it means in a given
 * Content (null once it is gone or out of scope), and what ends the watch
 * besides the request: the binding's invalidation, or the scope's revocation.
 */
interface WatchTarget {
  readonly artifactId: string;
  /** The watched entry's path in `artifact`; a scoped target re-checks its scope. */
  entry(artifact: ArtifactResolved): Promise<string | null>;
  /** A scope's revocation, which the guest hears about as a refusal. */
  readonly revoked?: AbortSignal;
  /** A binding's closing, which ends the watch quietly. */
  readonly signal?: AbortSignal;
}

const SCOPE_REVOKED = "Access to this Artifact was revoked";

/** The binding's entry, or an Artifact's entry under the broader scope. */
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
  // Taken before the scope is checked: a revoke that lands while the check
  // reads the Grants still ends this watch.
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
    // Each change re-reads the scope, so delivery stops with the Grant even
    // if a revoke never reached `scopes`.
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

/** Same committed entry: Content identity and the entry's digest and type. */
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

/**
 * A snapshot of the entry, then each committed change once (a recovery
 * that reapplies the same state yields nothing) and its removal, which ends
 * the stream. Changes that arrive while the consumer is busy collapse into
 * the latest state. Ends when the request is cancelled or the binding is
 * invalidated; a revoked scope refuses.
 */
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
