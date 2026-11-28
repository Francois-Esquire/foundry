import { describe, expect, it } from "vitest";
import {
  closeInstance,
  createInstanceRegistry,
  instanceGone,
  openInstance,
  sameInstance,
} from "../instance-identity";

describe("instance-identity", () => {
  it("tracks live instances and requires an explicit processGone predicate in pure instanceGone", () => {
    const self = { pid: 1001, started: "ps:Sun Nov 15 08:00:00 2026" };
    const other = { pid: 2002, started: "ps:Sun Nov 15 08:00:00 2026" };
    const opened = openInstance(self, "inst-1");
    try {
      expect(sameInstance(opened, { ...self, instanceId: "inst-1" })).toBe(
        true
      );
      expect(sameInstance(opened, { ...self, instanceId: "inst-2" })).toBe(
        false
      );
      expect(instanceGone(opened, self, () => true)).toBe(false);
      expect(instanceGone(other, self, () => true)).toBe(true);
      expect(instanceGone(other, self, () => false)).toBe(false);
    } finally {
      closeInstance(opened);
    }
    expect(instanceGone(opened, self, () => false)).toBe(true);
  });

  it("isolates live instance tracking across separate registries", () => {
    const self = { pid: 0, started: "portable:tenant-a" };
    const first = createInstanceRegistry({ id: () => "scoped-1" });
    const second = createInstanceRegistry({ id: () => "scoped-2" });
    const opened = first.open(self);
    expect(opened.instanceId).toBe("scoped-1");
    expect(first.isGone(opened, self, () => true)).toBe(false);
    expect(second.isGone(opened, self, () => false)).toBe(true);
    first.close(opened);
    expect(first.isGone(opened, self, () => false)).toBe(true);
  });
});
