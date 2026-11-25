import { describe, expect, it } from "vitest";
import {
  closeInstance,
  instanceGone,
  openInstance,
  sameInstance,
} from "../instance-identity";
import { nodeInstanceGone } from "../node/instance-identity";
import { thisProcess } from "../node/process-identity";
import { anotherStart } from "../testing/process-identity";

describe("instance-identity (Web-standard and Node adapter)", () => {
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

  it("node/instance-identity defaults processGone to OS isGone and shares live tracking", () => {
    const self = thisProcess();
    const opened = openInstance(self, "inst-node-1");
    try {
      expect(nodeInstanceGone(opened, self)).toBe(false);
      expect(
        nodeInstanceGone({ pid: self.pid, started: anotherStart() }, self)
      ).toBe(true);
    } finally {
      closeInstance(opened);
    }
    expect(nodeInstanceGone(opened, self)).toBe(true);
  });
});
