import { defineOwnEntry } from "./own-entry";

/**
 * A deep copy of `value` that shares no memory with it: `structuredClone`,
 * then every byte view or buffer in shared memory copied into memory of its
 * own. `structuredClone` keeps a `SharedArrayBuffer` shared, so a copy that
 * holds one would still change when the original's bytes do, on Node.
 * A byte view over shared memory becomes a view of the same type over a
 * fresh `ArrayBuffer`; a bare `SharedArrayBuffer` becomes a fresh one.
 * Throws what `structuredClone` throws for a value it cannot copy.
 */
export function detached<T>(value: T): T {
  return unshared(structuredClone(value), new WeakMap()) as T;
}

/** `value`, which this module owns, with shared memory replaced in place. */
function unshared(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (isSharedBuffer(value)) {
    const fresh = new SharedArrayBuffer(value.byteLength);
    new Uint8Array(fresh).set(new Uint8Array(value));
    seen.set(value, fresh);
    return fresh;
  }
  if (ArrayBuffer.isView(value)) {
    const fresh = isSharedBuffer(value.buffer) ? ownBytes(value) : value;
    seen.set(value, fresh);
    return fresh;
  }
  seen.set(value, value);
  if (value instanceof Map) {
    const entries = [...value].map(([key, entry]) => [
      unshared(key, seen),
      unshared(entry, seen),
    ]);
    value.clear();
    for (const [key, entry] of entries) {
      value.set(key, entry);
    }
    return value;
  }
  if (value instanceof Set) {
    const entries = [...value].map((entry) => unshared(entry, seen));
    value.clear();
    for (const entry of entries) {
      value.add(entry);
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    const replaced = unshared(entry, seen);
    if (replaced !== entry) {
      defineOwnEntry(record, key, replaced);
    }
  }
  return value;
}

function isSharedBuffer(value: unknown): value is SharedArrayBuffer {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  );
}

/** The bytes `view` shows, in a view of the same type over memory of its own. */
function ownBytes(view: ArrayBufferView): ArrayBufferView {
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  if (view instanceof DataView) {
    return new DataView(bytes.buffer);
  }
  const Typed = view.constructor as new (
    buffer: ArrayBuffer,
    byteOffset: number,
    length: number
  ) => ArrayBufferView;
  const width =
    (view as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
  return new Typed(bytes.buffer, 0, view.byteLength / width);
}
