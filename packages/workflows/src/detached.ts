export function detached<T>(value: T): T {
  return unshared(structuredClone(value), new Map()) as T;
}

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
