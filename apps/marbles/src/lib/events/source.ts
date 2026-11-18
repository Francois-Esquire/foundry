import type { SessionChangeEvent } from "@foundry/agents/schema";
import type { ArtifactEvent } from "@foundry/artifacts";
import type { SandboxEvent } from "@foundry/sandbox/store";
import type { TaskEvent } from "@foundry/tasks";
import type { RunEvent } from "@foundry/workflows/schema";
import type { WorkspaceEvent } from "@foundry/workspaces/schema";
import type { ArtifactShareEvent } from "~/lib/resources";

declare const payloadType: unique symbol;

export interface Fact {
  readonly at: string;
  readonly id: string;
  readonly type: string;
}

export type Source<T extends Fact = Fact> = symbol & {
  readonly [payloadType]?: T;
};

export type Handler<T> = (fact: T) => void | Promise<void>;

export const SOURCE: unique symbol = Symbol("marbles.source");

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

export function sourceKey(source: symbol): string | undefined {
  return keys.get(source);
}

export const TASKS: Source<TaskEvent> = defineSource("tasks");
export const RUNS: Source<RunEvent> = defineSource("runs");
export const ARTIFACTS: Source<ArtifactEvent | ArtifactShareEvent> =
  defineSource("artifacts");
export const SANDBOXES: Source<SandboxEvent> = defineSource("sandboxes");
export const SESSIONS: Source<SessionChangeEvent> = defineSource("sessions");
export const WORKSPACES: Source<WorkspaceEvent> = defineSource("workspaces");

export function observable<O extends object, T extends Fact>(
  target: O,
  source: Source<T>
): O & Observable<T> {
  Object.defineProperty(target, SOURCE, { value: source });
  return target as O & Observable<T>;
}
