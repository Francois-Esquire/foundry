import { describe, expect, it } from "vitest";

import { Ledger } from "~/lib/ledger";
import { RunScope, raceAbort, runs } from "~/lib/run-scope";

describe("RunScope", () => {
  it("registers itself while live and forgets itself on settle", async () => {
    const scope = new RunScope("run-1", "/tmp");
    expect(runs.get("run-1")).toBe(scope);
    await scope.settle();
    expect(runs.has("run-1")).toBe(false);
  });

  it("creates one frame per path and chains its signal under the run's", () => {
    const scope = new RunScope("run-2", "/tmp");
    const frame = scope.frame(["root", "a"]);
    expect(scope.frame(["root", "a"])).toBe(frame);
    expect(frame.key).toBe("root.a");
    expect(frame.signal.aborted).toBe(false);
    scope.abort(new Error("stop"));
    expect(frame.signal.aborted).toBe(true);
    expect(scope.frame(["root", "b"]).signal.aborted).toBe(true);
    runs.delete("run-2");
  });

  it("counts occurrences per kind and restarts them when the body re-enters", async () => {
    const scope = new RunScope("run-3", "/tmp");
    const frame = scope.frame(["root"]);
    expect(scope.claim(frame, "ask")).toEqual({
      key: "quirks:root|ask|0",
      occurrence: 0,
    });
    expect(scope.claim(frame, "ask").occurrence).toBe(1);
    expect(scope.claim(frame, "session").occurrence).toBe(0);
    await scope.enter(frame);
    expect(scope.claim(frame, "ask").occurrence).toBe(0);
    runs.delete("run-3");
  });

  it("waits for detached children before a body re-enters", async () => {
    const scope = new RunScope("run-4", "/tmp");
    const frame = scope.frame(["root"]);
    let settled = false;
    frame.detached = [
      new Promise((resolve) =>
        setTimeout(() => {
          settled = true;
          resolve(undefined);
        }, 10)
      ),
    ];
    await scope.enter(frame);
    expect(settled).toBe(true);
    expect(frame.detached).toEqual([]);
    runs.delete("run-4");
  });

  it("closes what frames opened when it settles", async () => {
    const scope = new RunScope("run-5", "/tmp");
    const closed: string[] = [];
    scope.frame(["root"]).opened.add({
      close: () => {
        closed.push("a");
      },
    });
    scope.frame(["root", "x"]).opened.add({
      close: () => {
        closed.push("b");
        throw new Error("ignored");
      },
    });
    await scope.settle();
    expect(closed.sort()).toEqual(["a", "b"]);
  });

  it("raceAbort rejects a running body when its frame aborts", async () => {
    const scope = new RunScope("run-6", "/tmp");
    const frame = scope.frame(["root"]);
    const never = new Promise<string>(() => undefined);
    const racing = raceAbort(frame, never);
    frame.controller.abort(new Error("cancelled"));
    await expect(racing).rejects.toThrow("cancelled");
    await expect(raceAbort(frame, Promise.resolve("x"))).rejects.toThrow(
      "cancelled"
    );
    runs.delete("run-6");
  });
});

describe("Ledger", () => {
  it("stores by path, kind, and occurrence", () => {
    const ledger = new Ledger();
    const key = Ledger.key(["root", "a"], "session", 1);
    expect(key).toBe("quirks:root.a|session|1");
    expect(ledger.has(key)).toBe(false);
    ledger.set(key, { id: "s1" });
    expect(ledger.get<{ id: string }>(key)?.id).toBe("s1");
    expect(ledger.size).toBe(1);
  });
});
