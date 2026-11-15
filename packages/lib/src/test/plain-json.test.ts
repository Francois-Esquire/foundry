import { describe, expect, it } from "vitest";

import { ownedEvents, ownedWrite, plainJson } from "../plain-json";

describe("plainJson", () => {
  it("copies plain JSON, each part its own", () => {
    const value = { a: [1, "two", true, null], b: { c: 3 } };
    const copy = plainJson("value", value);
    expect(copy).toStrictEqual(value);
    expect(copy).not.toBe(value);
    expect((copy as typeof value).a).not.toBe(value.a);
  });

  it("keeps a __proto__ key an own property", () => {
    const value = JSON.parse('{"__proto__":{"x":1}}') as object;
    const copy = plainJson("value", value) as object;
    expect(Object.keys(copy)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
  });

  const holed = (): unknown[] => {
    const array: unknown[] = [];
    array[1] = 1;
    return array;
  };
  const tagged = (): unknown[] => Object.assign([1], { extra: 2 });
  const refused: [string, unknown][] = [
    ["v must be a finite number other than -0", Number.NaN],
    ["v must be a finite number other than -0", -0],
    ["v has no JSON form (bigint)", 1n],
    ["v has no JSON form (undefined)", undefined],
    ["v.f has no JSON form (function)", { f: () => undefined }],
    ["v must be a plain object", new Date(0)],
    ["v must be a plain object", { [Symbol("s")]: 1 }],
    ["v[0] is a hole in an array", holed()],
    ["v must be a plain array holding only its entries", tagged()],
  ];
  it.each(refused)("refuses with '%s'", (message, value) => {
    expect(() => plainJson("v", value)).toThrow(TypeError);
    expect(() => plainJson("v", value)).toThrow(message);
  });

  it("refuses a value that contains itself, and takes one seen twice", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => plainJson("v", cyclic)).toThrow("v.self contains itself");
    const shared = { x: 1 };
    expect(plainJson("v", [shared, shared])).toStrictEqual([shared, shared]);
  });
});

describe("ownedEvents", () => {
  it("is undefined for no events and refuses a list that is not an array", () => {
    expect(ownedEvents(undefined)).toBeUndefined();
    expect(() => ownedEvents({})).toThrow("events must be an array");
    expect(() => ownedEvents([{ at: new Date(0) }])).toThrow(
      "events[0].at must be a plain object"
    );
  });
});

describe("ownedWrite", () => {
  it("takes the events as plain JSON and clones the rest, leaving no events field for none", () => {
    const write = { events: [{ type: "x" }], puts: [{ at: new Date(0) }] };
    const copy = ownedWrite(write);
    expect(copy).toStrictEqual(write);
    const [put] = copy.puts;
    expect(put).not.toBe(write.puts[0]);
    expect(put).toStrictEqual({ at: new Date(0) });
    const none: { events?: unknown[]; puts: unknown[] } = { puts: [] };
    expect("events" in ownedWrite(none)).toBe(false);
  });
});
