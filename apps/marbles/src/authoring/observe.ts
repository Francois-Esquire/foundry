import type { SessionChangeEvent } from "@foundry/agents/schema";
import type { ArtifactEvent } from "@foundry/artifacts";
import type { SandboxEvent } from "@foundry/sandbox/store";
import type { RunEvent } from "@foundry/workflows/schema";
import type { WorkspaceEvent } from "@foundry/workspaces/schema";
import type { workflow } from "~/authoring/builder";
import { bindingAt, callSite } from "~/authoring/identity";
import type {
  agent,
  artifact,
  sandbox,
  workspace,
} from "~/authoring/resources";
import { declaringCatalog } from "~/authoring/runtime";
import type { Fact, Handler, Observable } from "~/lib/events/source";
import { SOURCE, sourceKey } from "~/lib/events/source";
import type { ArtifactShareEvent } from "~/lib/resources";

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
  const name = observerName(options.name, handler);
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
  declaringCatalog().observe({
    handler: handler as Handler<unknown>,
    name,
    source: symbol,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.types === undefined ? {} : { types: [...options.types] }),
  });
  return Object.freeze({ kind: "observer", name, source: key });
}

export interface ObserveOptions<T extends Fact> {
  readonly name?: string;
  readonly timeout?: number;
  readonly types?: readonly T["type"][];
}

export interface Observer {
  readonly kind: "observer";
  readonly name: string;
  readonly source: string;
}

function observerName(
  given: string | undefined,
  handler: Handler<never>
): string {
  if (given !== undefined) {
    if (given.trim() === "") {
      throw new TypeError("observe: an observer's name cannot be blank");
    }
    return given.trim();
  }
  const site = callSite();
  const bound = site === undefined ? undefined : bindingAt(site);
  const name = bound ?? handler.name;
  if (name === "") {
    throw new TypeError(
      "observe: name this observer: pass `{ name }`, assign the call to a top-level const, or give the handler a function name"
    );
  }
  return name;
}
