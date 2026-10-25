import { describe, expect, test } from "vitest";
import {
  formatDuration,
  ScanProgress,
  summaryLine,
} from "../../src/cli/progress";
import type {
  CollectionProgressEvent,
  ScanProgressEvent,
} from "../../src/lib/scan";
import type { SemanticsInvalidation } from "../../src/lib/semantics-types";

/** A clock that advances by a fixed step per read. */
function clock(step = 100): () => number {
  let now = 0;
  return () => {
    now += step;
    return now;
  };
}

const local = (
  id: string,
  status: SemanticsInvalidation["status"]
): SemanticsInvalidation => ({
  id,
  kind: "package-local",
  reason: { cause: "package-added", type: "direct" },
  status,
});

const unit = (
  name: string,
  status: "complete" | "failed" | "reused" | "started",
  done: number,
  total: number,
  durationMs = 0
): Extract<ScanProgressEvent, { kind: "unit" }> => ({
  done,
  durationMs,
  kind: "unit",
  status,
  total,
  unit: name,
});

describe("ScanProgress", () => {
  test("returns the piped lines: phases, internals, and nothing for the rest", () => {
    const progress = new ScanProgress(clock());
    expect(progress.fold({ kind: "phase", phase: "discover" })).toEqual([
      "discover",
    ]);
    expect(
      progress.fold({
        detail: "0 of 2 local reports",
        kind: "phase",
        phase: "analyze",
      })
    ).toEqual(["analyze: 0 of 2 local reports"]);
    expect(progress.fold({ invalidations: [], kind: "plan" })).toEqual([]);
    expect(progress.fold(unit("@s/a", "started", 0, 2))).toEqual([]);
    expect(
      progress.fold({ index: 1, kind: "internals", package: "@s/a", total: 2 })
    ).toEqual(["internals: @s/a"]);
    expect(progress.snapshot.workspaces).toBe(1);
  });

  test("closes a phase with its duration when the next begins, and merges a repeated phase's detail", () => {
    const progress = new ScanProgress(clock(100));
    progress.fold({ kind: "phase", phase: "discover" });
    progress.fold({ kind: "phase", phase: "fingerprint" });
    progress.fold({ kind: "phase", phase: "derive" });
    progress.fold({ detail: "program 5ms", kind: "phase", phase: "derive" });
    const { phases } = progress.snapshot;
    expect(phases.map((phase) => phase.name)).toEqual([
      "discover",
      "fingerprint",
      "derive",
    ]);
    expect(phases[0]?.durationMs).toBe(100);
    expect(phases[1]?.durationMs).toBe(100);
    expect(phases[2]).toMatchObject({ detail: "program 5ms" });
    expect(phases[2]?.durationMs).toBeUndefined();
  });

  test("tracks packages: the plan's counts, who is active, and what each became", () => {
    const progress = new ScanProgress(clock());
    progress.fold({
      invalidations: [
        local("@s/a", "recompute"),
        local("@s/b", "recompute"),
        local("@s/c", "reuse"),
        { ...local("report", "recompute"), kind: "package-report" },
      ],
      kind: "plan",
    });
    expect(progress.snapshot.plan).toEqual({ recompute: 2, reuse: 1 });
    progress.fold(unit("@s/c", "reused", 1, 3));
    progress.fold(unit("@s/a", "started", 1, 3));
    progress.fold(unit("@s/b", "started", 1, 3));
    expect(progress.snapshot.units.active.map((a) => a.unit)).toEqual([
      "@s/a",
      "@s/b",
    ]);
    progress.fold(unit("@s/a", "complete", 2, 3, 250));
    progress.fold({
      ...unit("@s/b", "failed", 3, 3, 40),
      error: "tsconfig missing",
    });
    const { units } = progress.snapshot;
    expect(units).toMatchObject({
      active: [],
      analyzed: 1,
      done: 3,
      failed: 1,
      reused: 1,
      total: 3,
    });
    expect(units.recent.map((r) => [r.unit, r.status])).toEqual([
      ["@s/b", "failed"],
      ["@s/a", "complete"],
      ["@s/c", "reused"],
    ]);
    expect(units.recent[0]?.error).toBe("tsconfig missing");
  });

  test("a collection names each workspace once and starts its phases afresh", () => {
    const progress = new ScanProgress(clock());
    const of = (
      root: string,
      event: ScanProgressEvent
    ): CollectionProgressEvent => ({
      event,
      id: root,
      kind: "workspace",
      root,
    });
    expect(
      progress.fold(of("/a", { kind: "phase", phase: "discover" }))
    ).toEqual(["workspace: /a", "discover"]);
    expect(progress.fold(of("/a", unit("@a/x", "complete", 1, 1, 10)))).toEqual(
      []
    );
    expect(
      progress.fold(of("/b", { kind: "phase", phase: "discover" }))
    ).toEqual(["workspace: /b", "discover"]);
    progress.fold(of("/b", unit("@b/y", "reused", 1, 2)));
    const { snapshot } = progress;
    expect(snapshot.workspace).toBe("/b");
    expect(snapshot.workspaces).toBe(2);
    expect(snapshot.phases).toHaveLength(1);
    expect(snapshot.units).toMatchObject({
      analyzed: 1,
      done: 1,
      reused: 1,
      total: 2,
    });
  });

  test("folds history phases and checkpoints", () => {
    const progress = new ScanProgress(clock());
    progress.fold({
      event: { kind: "phase", phase: "timeline" },
      kind: "history",
    });
    progress.fold({
      event: {
        commit: "abc",
        done: 1,
        durationMs: 5,
        kind: "checkpoint",
        status: "cached",
        timestamp: "2026-01-01T00:00:00Z",
        total: 3,
      },
      kind: "history",
    });
    expect(progress.snapshot.history).toMatchObject({
      checkpoints: { cached: 1, done: 1, failed: 0, total: 3 },
    });
    expect(progress.snapshot.history?.phases[0]?.name).toBe("timeline");
  });
});

describe("summaryLine", () => {
  test("reads at the scale of the duration", () => {
    expect(formatDuration(450)).toBe("0.5s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });

  test("counts one workspace's packages, and a collection's workspaces", () => {
    const one = new ScanProgress(() => 0);
    one.fold(unit("@s/a", "reused", 1, 2));
    one.fold(unit("@s/b", "complete", 2, 2, 30));
    expect(summaryLine(one.snapshot, 41_000)).toBe(
      "Scanned 2 packages in 41s: 1 analyzed, 1 reused."
    );
    const many = new ScanProgress(() => 0);
    const of = (
      root: string,
      event: ScanProgressEvent
    ): CollectionProgressEvent => ({
      event,
      id: root,
      kind: "workspace",
      root,
    });
    many.fold(of("/a", unit("@a/x", "complete", 1, 1, 10)));
    many.fold(of("/b", { ...unit("@b/y", "failed", 1, 1, 10), error: "boom" }));
    expect(summaryLine(many.snapshot, 3000)).toBe(
      "Scanned 2 workspaces, 2 packages in 3.0s: 1 analyzed, 0 reused, 1 failed."
    );
  });
});
