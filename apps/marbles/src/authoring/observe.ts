import type { SessionChangeEvent } from "@foundry/agents/session";
import type { ArtifactEvent } from "@foundry/artifacts";
import type { SandboxEvent } from "@foundry/sandbox/store";
import type { WorkspaceEvent } from "@foundry/workspaces/schema";
import type { workflow } from "~/authoring/builder";
import type {
  agent,
  artifact,
  sandbox,
  workspace,
} from "~/authoring/resources";
import { trackCreatedDeclaration } from "~/authoring/runtime";
import type { Fact, Handler, Observable, Source } from "~/lib/events/source";
import { SOURCE, sourceKey } from "~/lib/events/source";
import { OBSERVER_META } from "~/lib/handles";
import type { ArtifactShareEvent } from "~/lib/resources";
import type { RunEvent } from "~/lib/workflow-runs";

export interface ObserverMeta {
  readonly explicitName: boolean;
  readonly handler: Handler<unknown>;
  readonly source: Source;
  readonly timeout?: number;
  readonly types?: readonly string[];
}

export function observe<T extends Fact>(
  source: Observable<T>,
  handler: Handler<T>,
  options?: ObserveOptions<T>
): Observer;
export function observe(
  source: typeof workflow,
  handler: Handler<RunEvent>,
  options?: ObserveOptions<RunEvent>
): Observer;
export function observe(
  source: typeof artifact,
  handler: Handler<ArtifactEvent | ArtifactShareEvent>,
  options?: ObserveOptions<ArtifactEvent | ArtifactShareEvent>
): Observer;
export function observe(
  source: typeof sandbox,
  handler: Handler<SandboxEvent>,
  options?: ObserveOptions<SandboxEvent>
): Observer;
export function observe(
  source: typeof workspace,
  handler: Handler<WorkspaceEvent>,
  options?: ObserveOptions<WorkspaceEvent>
): Observer;
export function observe(
  source: typeof agent,
  handler: Handler<SessionChangeEvent>,
  options?: ObserveOptions<SessionChangeEvent>
): Observer;
export function observe(
  source: unknown,
  handler: Handler<never>,
  options: ObserveOptions<Fact> = {}
): Observer {
  const symbol: unknown = (source as Partial<Observable<Fact>> | null)?.[
    SOURCE
  ];
  const key = typeof symbol === "symbol" ? sourceKey(symbol) : undefined;
  if (typeof symbol !== "symbol" || key === undefined) {
    throw new TypeError("observe: the source is not something Marbles emits");
  }
  if (typeof handler !== "function") {
    throw new TypeError("observe: the handler must be a function");
  }
  if (options.name !== undefined && options.name.trim() === "") {
    throw new TypeError("observe: an observer's name cannot be blank");
  }
  if (options.types?.length === 0) {
    throw new TypeError(
      "observe: `types` names no type; leave it out to observe every type"
    );
  }
  if (
    options.timeout !== undefined &&
    !(Number.isFinite(options.timeout) && options.timeout > 0)
  ) {
    throw new TypeError(
      "observe: `timeout` is how many ms one call may run, above 0"
    );
  }
  const explicitName = options.name !== undefined;
  const name = explicitName ? options.name.trim() : handler.name;
  const types = options.types === undefined ? undefined : [...options.types];
  const observer: Observer = {
    handler: handler as Handler<unknown>,
    kind: "observer",
    name,
    source: key,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(types === undefined ? {} : { types }),
  };
  Object.defineProperty(observer, OBSERVER_META, {
    value: {
      explicitName,
      handler: handler as Handler<unknown>,
      source: symbol,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(types === undefined ? {} : { types }),
    } satisfies ObserverMeta,
  });
  const frozen = Object.freeze(observer);
  trackCreatedDeclaration(frozen);
  return frozen;
}

export interface ObserveOptions<T extends Fact> {
  readonly name?: string;
  readonly timeout?: number;
  readonly types?: readonly T["type"][];
}

export interface Observer {
  readonly handler: Handler<unknown>;
  readonly kind: "observer";
  readonly name: string;
  readonly source: string;
  readonly timeout?: number;
  readonly types?: readonly string[];
}
