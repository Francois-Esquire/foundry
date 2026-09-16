/**
 * Telemetry — direct unit tests of the in-memory metrics + log
 * ring-buffer primitive shared by Queue and Workflow.
 */

import { describe, expect, it } from "vitest";

import { Telemetry } from "../telemetry";

describe("Telemetry", () => {
  describe("metrics", () => {
    it("incrementMetric accumulates by 1 by default", () => {
      const t = new Telemetry();
      t.incrementMetric("a");
      t.incrementMetric("a");
      t.incrementMetric("a");
      expect(t.snapshot().metrics.values.a).toBe(3);
    });

    it("incrementMetric accepts a custom step", () => {
      const t = new Telemetry();
      t.incrementMetric("a", 5);
      t.incrementMetric("a", 2);
      expect(t.snapshot().metrics.values.a).toBe(7);
    });

    it("setMetric overwrites the previous value", () => {
      const t = new Telemetry();
      t.incrementMetric("a", 4);
      t.setMetric("a", 0);
      expect(t.snapshot().metrics.values.a).toBe(0);
    });

    it("snapshot.metrics.updatedAt is monotonic across writes", async () => {
      const t = new Telemetry();
      t.incrementMetric("a");
      const first = t.snapshot().metrics.updatedAt;
      // Bump system time enough that toISOString() rolls forward.
      await new Promise((r) => setTimeout(r, 5));
      t.incrementMetric("a");
      const second = t.snapshot().metrics.updatedAt;
      expect(second >= first).toBe(true);
    });
  });

  describe("logs", () => {
    it("appendLog records level, message, optional metadata", () => {
      const t = new Telemetry();
      t.appendLog({ level: "info", message: "hello" });
      t.appendLog({
        level: "warn",
        message: "with meta",
        metadata: { runId: "rn_1" },
      });
      const { logs } = t.snapshot();
      expect(logs).toHaveLength(2);
      expect(logs[0]?.level).toBe("info");
      expect(logs[0]?.message).toBe("hello");
      expect(logs[0]?.metadata).toBeUndefined();
      expect(logs[1]?.metadata).toEqual({ runId: "rn_1" });
    });

    it("appendLog uses the provided `at` when given", () => {
      const t = new Telemetry();
      t.appendLog({
        at: "2026-01-01T00:00:00.000Z",
        level: "info",
        message: "fixed",
      });
      expect(t.snapshot().logs[0]?.at).toBe("2026-01-01T00:00:00.000Z");
    });

    it("respects logCapacity by dropping oldest entries", () => {
      const t = new Telemetry({ logCapacity: 3 });
      for (const i of [1, 2, 3, 4, 5]) {
        t.appendLog({ level: "info", message: `m${i}` });
      }
      const { logs } = t.snapshot();
      expect(logs).toHaveLength(3);
      expect(logs.map((l) => l.message)).toEqual(["m3", "m4", "m5"]);
    });
  });

  describe("snapshot", () => {
    it("returns a value that doesn't reflect later mutations", () => {
      const t = new Telemetry();
      t.incrementMetric("a");
      t.appendLog({ level: "info", message: "first" });
      const snap = t.snapshot();

      t.incrementMetric("a");
      t.appendLog({ level: "info", message: "second" });

      expect(snap.metrics.values.a).toBe(1);
      expect(snap.logs).toHaveLength(1);
      expect(snap.logs[0]?.message).toBe("first");
    });
  });
});
