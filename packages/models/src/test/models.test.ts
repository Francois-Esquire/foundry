import { expect, it } from "vitest";
import { ModelsEventEmitter } from "../models";

it("preserves EventEmitter semantics on ModelsEventEmitter", () => {
  const emitter = new ModelsEventEmitter();
  const seen: string[] = [];
  let receiver: unknown;

  const repeated = function (this: unknown, value: string) {
    receiver = this;
    seen.push(`on:${value}`);
  };
  emitter.addListener("tick", repeated).on("tick", repeated);
  expect(emitter.listenerCount("tick")).toBe(2);

  let nestedCalls = 0;
  emitter.once("tick", () => {
    nestedCalls += 1;
    if (nestedCalls === 1) {
      emitter.emit("tick", "nested");
    }
  });
  expect(emitter.listenerCount("tick")).toBe(3);

  expect(emitter.emit("tick", "first")).toBe(true);
  expect(receiver).toBe(emitter);
  expect(nestedCalls).toBe(1);
  expect(emitter.listenerCount("tick")).toBe(2);

  emitter.removeListener("tick", repeated);
  expect(emitter.listenerCount("tick")).toBe(1);
  emitter.off("tick", repeated);
  expect(emitter.listenerCount("tick")).toBe(0);
  expect(emitter.emit("tick", "none")).toBe(false);

  emitter.on("a", () => undefined).on("b", () => undefined);
  emitter.removeAllListeners("a");
  expect(emitter.listenerCount("a")).toBe(0);
  expect(emitter.listenerCount("b")).toBe(1);
  emitter.removeAllListeners();
  expect(emitter.listenerCount("b")).toBe(0);

  const boom = new Error("unhandled");
  expect(() => emitter.emit("error", boom)).toThrow(boom);
});
