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

/**
 * Call `handler` with every change fact `source` commits in the workspace
 * from now on: `tasks` (`tasks.changed`), `workflow` (each Run's
 * `run.queued`, `run.started`, ...), `artifact`, `sandbox`, `workspace`,
 * and `agent` (its sessions' `session.*`). Every fact is kept in the
 * Marbles database with the change that made it, and every observer's
 * place in them, so a handler receives each fact after its place: one it
 * threw on is tried again after a backoff, and one its process stopped
 * before is handed to it at the next start. A handler can therefore see a
 * fact more than once. The host delivers from its start; the handler runs
 * outside any write, and may change things itself.
 *
 * An observer is known by its name within the workspace and source:
 * `options.name`, else the top-level `const` the call is assigned to,
 * else the handler's own function name. Editing its handler keeps its
 * place; renaming it starts a new observer, from now. `options.types`
 * hands it only facts of those types.
 *
 * Observers are delivered to independently: one slow, failing or hung
 * never delays another. A call that runs past `options.timeout` counts as
 * a failure; the observer is handed nothing more until that call settles,
 * then tried again on the same fact.
 */
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
  handler: Handler<ArtifactEvent>,
  options?: ObserveOptions<ArtifactEvent>
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

/** How `observe` declares an observer. */
export interface ObserveOptions<T extends Fact> {
  /** Its identity within the workspace and source; see `observe`. */
  readonly name?: string;
  /**
   * How long, in ms, one call of the handler may run before it counts as
   * a failure; five minutes, or the host's setting, when omitted.
   */
  readonly timeout?: number;
  /** Only facts of these types; every type of the source when omitted. */
  readonly types?: readonly T["type"][];
}

/** What `observe` declared: the observer's identity. */
export interface Observer {
  readonly kind: "observer";
  readonly name: string;
  /** The source's key: `tasks`, `runs`, `artifacts`, `sandboxes`, `workspaces` or `sessions`. */
  readonly source: string;
}

/**
 * The name given, else the top-level `const` the call is assigned to, else
 * the handler's own name; refused when there is none, since a name is what
 * keeps an observer's place across edits and restarts.
 */
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
