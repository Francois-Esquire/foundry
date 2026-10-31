import { catalog } from "~/authoring/catalog";
import type { Handler, Observable } from "~/lib/events/source";
import { SOURCE, sourceKey } from "~/lib/events/source";

/**
 * Call `handler` with every change `source` commits in the workspace, such
 * as each `tasks.changed` payload of `tasks`. Every change is stored, with
 * which handlers completed it, so a handler receives each change it has not
 * completed: those made before it was declared, and one it threw on, or
 * whose process stopped first, after a later change or the next start. A
 * handler can therefore see a payload more than once.
 *
 * The host delivers from its start; the handler runs outside any task
 * write, and may change tasks itself. Nothing identifies a handler but its
 * own source text: see the engine's `Delivery` for what editing one does.
 */
export function observe<T>(source: Observable<T>, handler: Handler<T>): void {
  const symbol: unknown = (source as Partial<Observable<T>> | null)?.[SOURCE];
  if (typeof symbol !== "symbol" || sourceKey(symbol) === undefined) {
    throw new TypeError("observe: the source is not something Marbles emits");
  }
  if (typeof handler !== "function") {
    throw new TypeError("observe: the handler must be a function");
  }
  // A source emits only its own payload type.
  catalog.observe(symbol, handler as Handler<unknown>);
}
