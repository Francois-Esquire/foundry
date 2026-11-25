import { describe, expect, it } from "vitest";
import {
  closeInstance,
  openInstance,
  instanceGone as pureInstanceGone,
  sameInstance,
} from "../instance-identity";
import { instanceGone } from "../node/instance-identity";
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
      expect(pureInstanceGone(opened, self, () => true)).toBe(false);
      expect(pureInstanceGone(other, self, () => true)).toBe(true);
      expect(pureInstanceGone(other, self, () => false)).toBe(false);
    } finally {
      closeInstance(opened);
    }
    expect(pureInstanceGone(opened, self, () => false)).toBe(true);
  });

  it("node/instance-identity defaults processGone to OS isGone and shares live tracking", () => {
    const self = thisProcess();
    const opened = openInstance(self, "inst-node-1");
    try {
      expect(instanceGone(opened, self)).toBe(false);
      expect(
        instanceGone({ pid: self.pid, started: anotherStart() }, self)
      ).toBe(true);
    } finally {
      closeInstance(opened);
    }
    expect(instanceGone(opened, self)).toBe(true);
  });
});
