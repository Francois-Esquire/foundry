import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { FULL_ROWS, layout, mountLoader } from "../src/cli/loader";
import type { ProgressSnapshot } from "../src/cli/progress";
import { ScanProgress } from "../src/cli/progress";

// The loader under OpenTUI's test renderer: the same renderables the
// terminal gets, drawn to a buffer the test reads back as text.

function midScan(): ProgressSnapshot {
  const progress = new ScanProgress(() => 0);
  progress.fold({ kind: "phase", phase: "discover" });
  progress.fold({ kind: "phase", phase: "fingerprint" });
  progress.fold({ kind: "phase", phase: "analyze" });
  progress.fold({
    done: 1,
    durationMs: 0,
    kind: "unit",
    status: "reused",
    total: 4,
    unit: "@repo/billing",
  });
  progress.fold({
    done: 2,
    durationMs: 480,
    kind: "unit",
    status: "complete",
    total: 4,
    unit: "@repo/checkout",
  });
  progress.fold({
    done: 2,
    durationMs: 0,
    kind: "unit",
    status: "started",
    total: 4,
    unit: "@repo/orders",
  });
  return progress.snapshot;
}

const text = (rows: ReturnType<typeof layout>) =>
  rows.map((row) => row.map((segment) => segment.text).join(""));

describe("layout", () => {
  test("the full panel: headline, phase trail, bar, then packages", () => {
    const rows = text(
      layout(midScan(), { color: false, compact: false }, 1200, 0)
    );
    expect(rows).toHaveLength(FULL_ROWS);
    expect(rows[0]).toBe("⠋ Scanning · analyzing packages 2 of 4 · 1.2s");
    expect(rows[1]).toBe("✓ discover 0.0s  ✓ fingerprint 0.0s  ● analyze 1.2s");
    expect(rows[2]).toBe("████████████░░░░░░░░░░░░ 2/4  1 analyzed · 1 reused");
    expect(rows.slice(3, 6)).toEqual([
      "  ▸ @repo/orders analyzing 1.2s",
      "  ✓ @repo/checkout 0.5s",
      "  ↺ @repo/billing reused",
    ]);
  });

  test("compact: two rows, the headline and the bar", () => {
    const rows = text(
      layout(midScan(), { color: false, compact: true }, 1200, 3)
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toStartWith("⠸ Scanning · analyzing packages 2 of 4");
    expect(rows[1]).toStartWith("████████████░░░░░░░░░░░░ 2/4");
  });

  test("names the workspace of a collection and the package whose internals run", () => {
    const progress = new ScanProgress(() => 0);
    const root = "/repos/platform";
    progress.fold({
      event: { kind: "phase", phase: "write" },
      id: root,
      kind: "workspace",
      root,
    });
    progress.fold({
      event: { index: 2, kind: "internals", package: "@p/api", total: 5 },
      id: root,
      kind: "workspace",
      root,
    });
    const rows = text(
      layout(progress.snapshot, { color: false, compact: false }, 500, 0)
    );
    expect(rows[0]).toBe(
      "⠋ Scanning platform · writing the dataset 2 of 5 · 0.5s"
    );
    expect(rows[2]).toContain("2/5 internals @p/api");
  });
});

describe("mountLoader", () => {
  test("draws the panel into the renderer's frame, in colour and without", async () => {
    for (const color of [true, false]) {
      const { renderer, renderOnce, captureCharFrame } =
        await createTestRenderer({
          height: FULL_ROWS,
          width: 80,
        });
      const mounted = mountLoader(renderer, { color, compact: false });
      mounted.draw(midScan(), 1200, 0);
      await renderOnce();
      const frame = captureCharFrame();
      expect(frame).toContain("Scanning · analyzing packages 2 of 4 · 1.2s");
      expect(frame).toContain("▸ @repo/orders analyzing 1.2s");
      expect(frame).toContain("↺ @repo/billing reused");
      renderer.destroy();
    }
  });

  test("cuts each row to the renderer's width", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer(
      {
        height: FULL_ROWS,
        width: 24,
      }
    );
    mountLoader(renderer, { color: false, compact: false }).draw(
      midScan(),
      1200,
      0
    );
    await renderOnce();
    const lines = captureCharFrame().split("\n");
    expect(lines[0]?.trimEnd()).toBe("⠋ Scanning · analyzing p");
    renderer.destroy();
  });
});
