import { describe, expect, it } from "vitest";
import { Credentials } from "../config/credentials";
import { ReactiveStore } from "../config/reactive-store";

describe("config listener semantics", () => {
  for (const [name, create] of [
    ["ReactiveStore", () => new ReactiveStore({ a: 1 })],
    ["Credentials", () => new Credentials()],
  ] as const) {
    it(`${name} fires once at most once across nested emissions`, () => {
      const target = create();
      let calls = 0;
      let reentered = false;
      target.on("ping", () => {
        if (!reentered) {
          reentered = true;
          target.emit("ping");
        }
      });
      target.once("ping", () => {
        calls += 1;
      });
      target.emit("ping");
      expect(calls).toBe(1);
    });

    it(`${name} preserves repeated registrations, per-event off, and receiver this`, () => {
      const target = create();
      const receivers: unknown[] = [];
      function record(this: unknown) {
        receivers.push(this);
      }

      target.on("dup", record);
      target.on("dup", record);
      target.emit("dup");
      expect(receivers).toEqual([target, target]);

      let onceCalls = 0;
      const fn = () => {
        onceCalls += 1;
      };
      target.once("a", fn);
      target.once("b", fn);
      target.off("a", fn);
      target.emit("a");
      expect(onceCalls).toBe(0);
      target.emit("b");
      expect(onceCalls).toBe(1);
    });
  }
});
