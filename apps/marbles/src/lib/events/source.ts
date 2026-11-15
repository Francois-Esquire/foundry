import type { SessionChangeEvent } from "@foundry/agents/schema";
import type { ArtifactEvent } from "@foundry/artifacts";
import type { SandboxEvent } from "@foundry/sandbox/store";
import type { TaskEvent } from "@foundry/tasks";
import type { RunEvent } from "@foundry/workflows/schema";
import type { WorkspaceEvent } from "@foundry/workspaces/schema";
import type { ArtifactShareEvent } from "~/lib/resources";

/**
 * Sources: what emits the change facts a workspace's observers receive.
 * Each is a unique symbol defined here under a fixed key, which tells a
 * defined source from any other symbol and names it in the change log
 * (`marbles_changes.source`). Keys are Marbles constants, not
 * author-supplied values. Every source's facts are recorded in the Marbles
 * database by the store that commits them (`database/changes.ts`).
 */

declare const payloadType: unique symbol;

/**
 * What every change fact a package builds carries: its type, an id of its
 * own, and when it was built (which cannot order commits; the log's
 * position does).
 */
export interface Fact {
  readonly at: string;
  readonly id: string;
  readonly type: string;
}

/** A source's identity. The fact it emits is carried in the type only. */
export type Source<T extends Fact = Fact> = symbol & {
  readonly [payloadType]?: T;
};

/** What an observer is handed: the fact, never the stored row. */
export type Handler<T> = (fact: T) => void | Promise<void>;

/** Where an object `observe` accepts keeps the source it emits under. */
export const SOURCE: unique symbol = Symbol("marbles.source");

/** An object whose changes `observe` can follow. */
export interface Observable<T extends Fact> {
  readonly [SOURCE]: Source<T>;
}

const keys = new Map<symbol, string>();
const sources = new Set<string>();

function defineSource<T extends Fact>(key: string): Source<T> {
  if (sources.has(key)) {
    throw new Error(`source "${key}" is already defined`);
  }
  const source = Symbol(key);
  keys.set(source, key);
  sources.add(key);
  return source as Source<T>;
}

/** The key the change log names `source` by; `undefined` for a symbol that is not one. */
export function sourceKey(source: symbol): string | undefined {
  return keys.get(source);
}

/** Every committed task change, one `tasks.changed` fact per write. */
export const TASKS: Source<TaskEvent> = defineSource("tasks");
/** Every change to a workflow Run: `run.queued`, `run.started`, ... */
export const RUNS: Source<RunEvent> = defineSource("runs");
/** Every change to an artifact: `artifact.created`, ... and, from Marbles, `artifact.shared` and `artifact.unshared`. */
export const ARTIFACTS: Source<ArtifactEvent | ArtifactShareEvent> =
  defineSource("artifacts");
/** Every change to a sandbox's container: `sandbox.created`, ... */
export const SANDBOXES: Source<SandboxEvent> = defineSource("sandboxes");
/** Every change to an agent session: `session.created`, ... */
export const SESSIONS: Source<SessionChangeEvent> = defineSource("sessions");
/** Every change to the workspace catalogue: `workspace.created`, ... */
export const WORKSPACES: Source<WorkspaceEvent> = defineSource("workspaces");

/** `target`, marked as emitting under `source`; nothing else about it changes. */
export function observable<O extends object, T extends Fact>(
  target: O,
  source: Source<T>
): O & Observable<T> {
  Object.defineProperty(target, SOURCE, { value: source });
  return target as O & Observable<T>;
}
