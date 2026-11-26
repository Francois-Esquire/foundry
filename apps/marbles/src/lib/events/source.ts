import type { SessionChangeEvent } from "@foundry/agents/session";
import type { ArtifactEvent } from "@foundry/artifacts";
import type { SandboxEvent } from "@foundry/sandbox/store";
import type { TaskEvent } from "@foundry/tasks";
import type { WorkspaceEvent } from "@foundry/workspaces/schema";
import type { ArtifactShareEvent } from "~/lib/resources";
import type { RunEvent } from "~/lib/workflow-runs";

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

export const SOURCE: unique symbol = Symbol.for("marbles.source") as never;

export interface Observable<T extends Fact> {
  readonly [SOURCE]: Source<T>;
}

const SOURCE_PREFIX = "marbles.source.";
const keys = new Map<symbol, string>();

function defineSource<T extends Fact>(key: string): Source<T> {
  const source = Symbol.for(`${SOURCE_PREFIX}${key}`);
  keys.set(source, key);
  return source as Source<T>;
}

export function sourceKey(source: symbol): string | undefined {
  const known = keys.get(source);
  if (known !== undefined) {
    return known;
  }
  const shared = Symbol.keyFor(source);
  if (shared?.startsWith(SOURCE_PREFIX)) {
    return shared.slice(SOURCE_PREFIX.length);
  }
  return undefined;
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
