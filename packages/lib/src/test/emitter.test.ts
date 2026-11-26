import { describe, expect, it } from "vitest";
import { TypedEmitter } from "../emitter";

interface SampleEvents {
  data: [value: string, count: number];
  error: [err: unknown];
  ping: [];
}

describe("TypedEmitter", () => {
  it("supports typed on/addListener/once/off/removeListener/removeAllListeners/listenerCount/emit", () => {
    const emitter = new TypedEmitter<SampleEvents>();
    const seen: string[] = [];

    const onData = (value: string, count: number) => {
      seen.push(`${value}:${String(count)}`);
    };

    expect(emitter.emit("ping")).toBe(false);
    emitter.addListener("data", onData).on("data", onData);
    expect(emitter.listenerCount("data")).toBe(2);

    expect(emitter.emit("data", "a", 1)).toBe(true);
    expect(seen).toEqual(["a:1", "a:1"]);

    emitter.removeListener("data", onData);
    expect(emitter.listenerCount("data")).toBe(1);
    emitter.off("data", onData);
    expect(emitter.listenerCount("data")).toBe(0);
    expect(emitter.emit("data", "b", 2)).toBe(false);

    emitter.on("ping", () => undefined).on("data", onData);
    emitter.removeAllListeners("ping");
    expect(emitter.listenerCount("ping")).toBe(0);
    expect(emitter.listenerCount("data")).toBe(1);
    emitter.removeAllListeners();
    expect(emitter.listenerCount("data")).toBe(0);
  });

  it("fires once at most once across recursive emissions", () => {
    const emitter = new TypedEmitter<SampleEvents>();
    let onceCalls = 0;
    let reentered = false;

    emitter.on("ping", () => {
      if (!reentered) {
        reentered = true;
        emitter.emit("ping");
      }
    });
    emitter.once("ping", () => {
      onceCalls += 1;
    });

    emitter.emit("ping");
    expect(onceCalls).toBe(1);
    expect(emitter.listenerCount("ping")).toBe(1);
  });

  it("binds receiver this and removes repeated listeners LIFO", () => {
    const emitter = new TypedEmitter<{ tick: [label: string] }>();
    const order: string[] = [];
    const receivers: unknown[] = [];

    function first(this: unknown, label: string) {
      receivers.push(this);
      order.push(`first:${label}`);
    }
    function second(this: unknown, label: string) {
      receivers.push(this);
      order.push(`second:${label}`);
    }

    emitter.on("tick", first).on("tick", second).on("tick", first);
    emitter.off("tick", first);
    emitter.emit("tick", "x");

    expect(order).toEqual(["first:x", "second:x"]);
    expect(receivers).toEqual([emitter, emitter]);
  });

  it("throws on unhandled error events and delivers handled error events", () => {
    const emitter = new TypedEmitter<SampleEvents>();
    const boom = new Error("boom");

    expect(() => emitter.emit("error", boom)).toThrow(boom);
    expect(() => emitter.emit("error", "bad")).toThrow("bad");

    const untyped = new TypedEmitter();
    expect(() => untyped.emit("error")).toThrow("Unhandled error.");

    const caught: unknown[] = [];
    emitter.on("error", (err) => {
      caught.push(err);
    });
    expect(emitter.emit("error", boom)).toBe(true);
    expect(caught).toEqual([boom]);
  });
});
