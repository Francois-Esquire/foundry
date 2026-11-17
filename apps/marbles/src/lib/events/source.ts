import type { TaskEvent } from "@foundry/tasks";

declare const payloadType: unique symbol;

/** A source's identity. The payload it emits is carried in the type only. */
export type Source<T> = symbol & { readonly [payloadType]?: T };

/** What an observer is handed: the payload, never the stored item. */
export type Handler<T> = (payload: T) => void | Promise<void>;

/** Where an object `observe` accepts keeps the source it emits under. */
export const SOURCE: unique symbol = Symbol("marbles.source");

/** An object whose changes `observe` can follow. */
export interface Observable<T> {
  readonly [SOURCE]: Source<T>;
}

const keys = new Map<symbol, string>();
const sources = new Map<string, symbol>();

function defineSource<T>(key: string): Source<T> {
  if (sources.has(key)) {
    throw new Error(`source "${key}" is already defined`);
  }
  const source = Symbol(key);
  keys.set(source, key);
  sources.set(key, source);
  return source as Source<T>;
}

/** The key a stored item names `source` by; `undefined` for a symbol that is not one. */
export function sourceKey(source: symbol): string | undefined {
  return keys.get(source);
}

/** Every committed task change, as one `tasks.changed` payload per write. */
export const TASKS: Source<TaskEvent> = defineSource("tasks");

/** `target`, marked as emitting under `source`; nothing else about it changes. */
export function observable<O extends object, T>(
  target: O,
  source: Source<T>
): O & Observable<T> {
  Object.defineProperty(target, SOURCE, { value: source });
  return target as O & Observable<T>;
}
