import { describe, expect, test } from "vitest";

import { detached } from "../detached";

/** A view onto fresh shared memory holding `bytes`. */
function sharedBytes(...bytes: number[]): Uint8Array {
  const view = new Uint8Array(new SharedArrayBuffer(bytes.length));
  view.set(bytes);
  return view;
}

/** Whether `value`, or anything it holds, sits in shared memory. */
function holdsShared(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (value instanceof SharedArrayBuffer) {
    return true;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer instanceof SharedArrayBuffer;
  }
  return entriesOf(value).some((entry) => holdsShared(entry, seen));
}

/** What a value holds: Map keys and values, Set values, own property values. */
function entriesOf(value: object): unknown[] {
  if (value instanceof Map) {
    return [...value].flat();
  }
  if (value instanceof Set) {
    return [...value];
  }
  return Object.getOwnPropertyNames(value).map(
    (key) => Object.getOwnPropertyDescriptor(value, key)?.value
  );
}

const TYPED_ARRAYS = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
] as const;

describe("detached", () => {
  test.each(TYPED_ARRAYS)(
    "copies a %o over shared memory into memory of its own",
    (Typed) => {
      const shared = new SharedArrayBuffer(Typed.BYTES_PER_ELEMENT * 4);
      // Typed-array constructors take shared memory; their types say ArrayBuffer.
      const view = new Typed(
        shared as unknown as ArrayBuffer,
        Typed.BYTES_PER_ELEMENT,
        2
      );
      new Uint8Array(shared).fill(3);

      const copy = detached({ view }).view;
      new Uint8Array(shared).fill(9);

      expect(copy).toBeInstanceOf(Typed);
      expect(copy.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      // A view onto part of a buffer keeps its place in it.
      expect([copy.byteOffset, copy.length]).toEqual([
        Typed.BYTES_PER_ELEMENT,
        2,
      ]);
      expect(new Uint8Array(copy.buffer).every((byte) => byte === 3)).toBe(
        true
      );
    }
  );

  test("copies a DataView onto part of shared memory", () => {
    const shared = new SharedArrayBuffer(8);
    const view = new DataView(shared, 2, 4);
    view.setUint8(0, 5);

    const copy = detached(view);
    view.setUint8(0, 9);

    expect(copy).toBeInstanceOf(DataView);
    expect(copy.buffer).not.toBeInstanceOf(SharedArrayBuffer);
    expect([copy.byteOffset, copy.byteLength, copy.getUint8(0)]).toEqual([
      2, 4, 5,
    ]);
  });

  test("copies a bare SharedArrayBuffer, and keeps views onto it together", () => {
    const shared = new SharedArrayBuffer(4);
    const view = new Uint8Array(shared);
    view[0] = 1;

    const copy = detached({
      buffer: shared,
      high: view.subarray(2),
      low: view,
    });
    view[0] = 9;

    expect(copy.buffer).toBeInstanceOf(ArrayBuffer);
    expect(copy.buffer).not.toBeInstanceOf(SharedArrayBuffer);
    expect(copy.low.buffer).toBe(copy.buffer);
    expect(copy.high.buffer).toBe(copy.buffer);
    expect(copy.low[0]).toBe(1);
    copy.low[2] = 4;
    expect(copy.high[0]).toBe(4);
    expect(view[2]).toBe(0);
  });

  test("copies a bare ArrayBuffer", () => {
    const buffer = new ArrayBuffer(2);
    const copy = detached({ buffer });
    new Uint8Array(buffer)[0] = 9;

    expect(new Uint8Array(copy.buffer)[0]).toBe(0);
  });

  test("reaches Map keys and values, and Set values", () => {
    const key = sharedBytes(1);
    const value = sharedBytes(2);
    const member = sharedBytes(3);

    const copy = detached({
      map: new Map<unknown, unknown>([[key, { value }]]),
      set: new Set([member]),
    });
    key[0] = 9;
    value[0] = 9;
    member[0] = 9;

    expect(holdsShared(copy)).toBe(false);
    const [[copiedKey, copiedValue]] = [...copy.map] as [
      [Uint8Array, { value: Uint8Array }],
    ];
    expect([copiedKey[0], copiedValue.value[0]]).toEqual([1, 2]);
    expect([...copy.set][0]?.[0]).toBe(3);
  });

  test("reaches an Error's cause, nested causes, and its own fields", () => {
    const bytes = sharedBytes(1);
    const inner = new Error("inner", { cause: { bytes } });
    const outer = new TypeError("outer", { cause: inner });

    const copy = detached({ outer });
    bytes[0] = 9;

    expect(copy.outer).toBeInstanceOf(TypeError);
    expect(holdsShared(copy)).toBe(false);
    const cause = (copy.outer.cause as Error).cause as { bytes: Uint8Array };
    expect(cause.bytes[0]).toBe(1);
    // `cause` stays an own property that is not enumerable.
    expect(
      Object.getOwnPropertyDescriptor(copy.outer, "cause")?.enumerable
    ).toBe(false);
  });

  test("reaches an AggregateError's errors where the clone keeps them", () => {
    const bytes = sharedBytes(1);
    const aggregate = new AggregateError(
      [new Error("inner", { cause: bytes })],
      "many"
    );

    const copy = detached(aggregate);
    bytes[0] = 9;

    // Node's clone keeps an AggregateError as an Error without `errors`;
    // a runtime that keeps them gets them walked like any other field.
    expect(holdsShared(copy)).toBe(false);
  });

  test("keeps a value that contains itself", () => {
    const bytes = sharedBytes(1);
    const cyclic: { self?: unknown; bytes: Uint8Array } = { bytes };
    cyclic.self = cyclic;
    const error = new Error("loop");
    Object.defineProperty(error, "cause", { value: error });

    const copy = detached({ cyclic, error });

    expect(copy.cyclic.self).toBe(copy.cyclic);
    expect(copy.error.cause).toBe(copy.error);
    expect(holdsShared(copy)).toBe(false);
  });
});
