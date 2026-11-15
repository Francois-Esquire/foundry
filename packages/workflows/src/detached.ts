/**
 * A deep copy of `value` that shares no memory with it: `structuredClone`,
 * then every `SharedArrayBuffer` in the copy, bare or behind a view, moved
 * into a fresh `ArrayBuffer` of its own. `structuredClone` keeps a
 * `SharedArrayBuffer` shared, so a copy that held one would still change
 * when the original's bytes do, on Node.
 *
 * Each shared buffer becomes one fresh `ArrayBuffer` holding its bytes, and
 * every view onto it (each typed-array kind and `DataView`) becomes a view
 * of the same kind, offset and length onto that buffer, so views the copy
 * held onto one buffer still share it with each other, and with the buffer
 * where the copy holds it bare. The walk reaches everything the clone
 * keeps: object and array entries, `Map` keys and values, `Set` values, and
 * an `Error`'s own properties, its non-enumerable `cause` included (and an
 * `AggregateError`'s `errors`, where the runtime's clone keeps them).
 * Throws what `structuredClone` throws for a value it cannot copy.
 */
export function detached<T>(value: T): T {
  return unshared(structuredClone(value), new Map()) as T;
}

/** `value`, which this module owns, with shared memory replaced in place. */
function unshared(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (isSharedBuffer(value)) {
    return ownBuffer(value, seen);
  }
  if (ArrayBuffer.isView(value)) {
    const fresh = isSharedBuffer(value.buffer)
      ? viewOnto(value, ownBuffer(value.buffer, seen))
      : value;
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
  } else if (value instanceof Set) {
    const entries = [...value].map((entry) => unshared(entry, seen));
    value.clear();
    for (const entry of entries) {
      value.add(entry);
    }
  } else {
    // An Error's `cause` (and `errors`) are own but not enumerable.
    const keys =
      value instanceof Error
        ? Object.getOwnPropertyNames(value)
        : Object.keys(value);
    for (const key of keys) {
      replaceOwn(value, key, seen);
    }
  }
  return value;
}

/** Replaces `target[key]`, an own data property, keeping its attributes. */
function replaceOwn(
  target: object,
  key: string,
  seen: Map<object, unknown>
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    return;
  }
  const replaced = unshared(descriptor.value, seen);
  if (replaced !== descriptor.value) {
    Object.defineProperty(target, key, { ...descriptor, value: replaced });
  }
}

function isSharedBuffer(value: unknown): value is SharedArrayBuffer {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  );
}

/** The one fresh `ArrayBuffer` that stands for `shared` in this copy. */
function ownBuffer(
  shared: SharedArrayBuffer,
  seen: Map<object, unknown>
): ArrayBuffer {
  const known = seen.get(shared);
  if (known instanceof ArrayBuffer) {
    return known;
  }
  const fresh = new ArrayBuffer(shared.byteLength);
  new Uint8Array(fresh).set(new Uint8Array(shared));
  seen.set(shared, fresh);
  return fresh;
}

/** A view of `view`'s kind, offset and length onto `buffer`. */
function viewOnto(view: ArrayBufferView, buffer: ArrayBuffer): ArrayBufferView {
  if (view instanceof DataView) {
    return new DataView(buffer, view.byteOffset, view.byteLength);
  }
  const Typed = view.constructor as new (
    buffer: ArrayBuffer,
    byteOffset: number,
    length: number
  ) => ArrayBufferView;
  const width = (view as unknown as { BYTES_PER_ELEMENT: number })
    .BYTES_PER_ELEMENT;
  return new Typed(buffer, view.byteOffset, view.byteLength / width);
}
