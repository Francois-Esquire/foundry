import { describe, expect, it } from "vitest";
import { deepStrictEqual } from "../equal";

const RE_ABC_GLOBAL = /abc/g;
const RE_ABC_GLOBAL_COPY = /abc/g;
const RE_ABC_INSENSITIVE = /abc/i;
const RE_ABD_GLOBAL = /abd/g;

describe("deepStrictEqual", () => {
  it("handles primitives, NaN, and signed zero with Object.is semantics", () => {
    expect(deepStrictEqual(1, 1)).toBe(true);
    expect(deepStrictEqual("a", "a")).toBe(true);
    expect(deepStrictEqual(true, true)).toBe(true);
    expect(deepStrictEqual(null, null)).toBe(true);
    expect(deepStrictEqual(undefined, undefined)).toBe(true);
    expect(deepStrictEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepStrictEqual(-0, +0)).toBe(false);
    expect(deepStrictEqual(-0, -0)).toBe(true);
    expect(deepStrictEqual(null, undefined)).toBe(false);
    expect(deepStrictEqual(1, "1")).toBe(false);
  });

  it("compares plain objects, prototypes, undefined keys, and enumerable symbols", () => {
    const sym = Symbol("k");
    const nonEnum = Symbol("hidden");
    expect(deepStrictEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(
      true
    );
    expect(deepStrictEqual({ a: undefined }, {})).toBe(false);
    expect(deepStrictEqual({ [sym]: 1 }, { [sym]: 1 })).toBe(true);
    expect(deepStrictEqual({ [sym]: 1 }, { [sym]: 2 })).toBe(false);

    const a = { x: 1 };
    const b = { x: 1 };
    Object.defineProperty(a, nonEnum, { enumerable: false, value: 1 });
    Object.defineProperty(b, nonEnum, { enumerable: false, value: 2 });
    expect(deepStrictEqual(a, b)).toBe(true);

    const nullProto = Object.assign(Object.create(null) as object, { a: 1 });
    expect(deepStrictEqual(nullProto, { a: 1 })).toBe(false);
    expect(
      deepStrictEqual(
        nullProto,
        Object.assign(Object.create(null) as object, { a: 1 })
      )
    ).toBe(true);
  });

  it("distinguishes sparse arrays, dense undefined, and extra own properties", () => {
    // biome-ignore lint/suspicious/noSparseArray: Intentionally testing sparse array equality.
    const sparse = [1, , 3];
    const dense = [1, undefined, 3];
    expect(deepStrictEqual(sparse, dense)).toBe(false);
    // biome-ignore lint/suspicious/noSparseArray: Intentionally testing sparse array equality.
    expect(deepStrictEqual(sparse, [1, , 3])).toBe(true);

    const withExtra = Object.assign([1, 2], { tag: "a" });
    expect(deepStrictEqual(withExtra, [1, 2])).toBe(false);
    expect(
      deepStrictEqual(withExtra, Object.assign([1, 2], { tag: "a" }))
    ).toBe(true);
  });

  it("handles cyclic references and distinguishes mismatched cycle topologies", () => {
    const a: { self?: unknown; value: number } = { value: 1 };
    a.self = a;
    const b: { self?: unknown; value: number } = { value: 1 };
    b.self = b;
    expect(deepStrictEqual(a, b)).toBe(true);

    const c: { self?: unknown; value: number } = { value: 1 };
    const d: { self?: unknown; value: number } = { self: c, value: 1 };
    c.self = d;
    expect(deepStrictEqual(a, c)).toBe(false);

    const arrA: unknown[] = [1];
    arrA.push(arrA);
    const arrB: unknown[] = [1];
    arrB.push(arrB);
    expect(deepStrictEqual(arrA, arrB)).toBe(true);
  });

  it("compares Date timestamps, invalid Dates, and own properties on Dates", () => {
    const d1 = new Date("2026-01-01T00:00:00.000Z");
    const d2 = new Date("2026-01-01T00:00:00.000Z");
    const d3 = new Date("2026-01-02T00:00:00.000Z");
    expect(deepStrictEqual(d1, d2)).toBe(true);
    expect(deepStrictEqual(d1, d3)).toBe(false);
    expect(deepStrictEqual(new Date(Number.NaN), new Date(Number.NaN))).toBe(
      true
    );

    const taggedA = Object.assign(new Date("2026-01-01T00:00:00.000Z"), {
      zone: "UTC",
    });
    const taggedB = Object.assign(new Date("2026-01-01T00:00:00.000Z"), {
      zone: "UTC",
    });
    const taggedC = Object.assign(new Date("2026-01-01T00:00:00.000Z"), {
      zone: "EST",
    });
    expect(deepStrictEqual(taggedA, d1)).toBe(false);
    expect(deepStrictEqual(taggedA, taggedB)).toBe(true);
    expect(deepStrictEqual(taggedA, taggedC)).toBe(false);
  });

  it("compares RegExp source, flags, and lastIndex", () => {
    const r1 = new RegExp(RE_ABC_GLOBAL.source, RE_ABC_GLOBAL.flags);
    const r2 = new RegExp(RE_ABC_GLOBAL_COPY.source, RE_ABC_GLOBAL_COPY.flags);
    expect(deepStrictEqual(r1, r2)).toBe(true);
    expect(deepStrictEqual(RE_ABC_GLOBAL, RE_ABC_INSENSITIVE)).toBe(false);
    expect(deepStrictEqual(RE_ABC_GLOBAL, RE_ABD_GLOBAL)).toBe(false);

    r1.lastIndex = 2;
    expect(deepStrictEqual(r1, r2)).toBe(false);
    r2.lastIndex = 2;
    expect(deepStrictEqual(r1, r2)).toBe(true);
  });

  it("compares ArrayBuffers and typed ArrayBufferViews respecting byteOffset and prototype", () => {
    const buf1 = new Uint8Array([1, 2, 3, 4]).buffer;
    const buf2 = new Uint8Array([1, 2, 3, 4]).buffer;
    const buf3 = new Uint8Array([1, 2, 3, 5]).buffer;
    expect(deepStrictEqual(buf1, buf2)).toBe(true);
    expect(deepStrictEqual(buf1, buf3)).toBe(false);
    expect(deepStrictEqual(buf1, new Uint8Array([1, 2, 3]).buffer)).toBe(false);

    const backing = new Uint8Array([0, 10, 20, 30, 0]).buffer;
    const slice = new Uint8Array(backing, 1, 3);
    expect(deepStrictEqual(slice, new Uint8Array([10, 20, 30]))).toBe(true);
    expect(deepStrictEqual(slice, new Uint8Array([10, 20, 31]))).toBe(false);
    expect(deepStrictEqual(slice, new Int8Array([10, 20, 30]))).toBe(false);
    expect(
      deepStrictEqual(
        new DataView(backing, 1, 3),
        new DataView(new Uint8Array([10, 20, 30]).buffer)
      )
    ).toBe(true);
  });

  it("compares Map and Set deeply and independently of insertion order", () => {
    const mapA = new Map<unknown, unknown>([
      [{ id: 1 }, { items: [1, 2] }],
      ["two", Number.NaN],
    ]);
    const mapB = new Map<unknown, unknown>([
      ["two", Number.NaN],
      [{ id: 1 }, { items: [1, 2] }],
    ]);
    const mapC = new Map<unknown, unknown>([
      ["two", Number.NaN],
      [{ id: 1 }, { items: [1, 3] }],
    ]);
    expect(deepStrictEqual(mapA, mapB)).toBe(true);
    expect(deepStrictEqual(mapA, mapC)).toBe(false);
    expect(deepStrictEqual(mapA, new Map([["two", Number.NaN]]))).toBe(false);

    const setA = new Set<unknown>([{ a: 1 }, Number.NaN, "x"]);
    const setB = new Set<unknown>(["x", Number.NaN, { a: 1 }]);
    const setC = new Set<unknown>(["x", Number.NaN, { a: 2 }]);
    expect(deepStrictEqual(setA, setB)).toBe(true);
    expect(deepStrictEqual(setA, setC)).toBe(false);
    expect(deepStrictEqual(setA, new Set([{ a: 1 }]))).toBe(false);
  });
});
