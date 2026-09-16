import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { StatusReport } from "../src/status/model";
import { statusText } from "../src/status/text";
import { createStatusView } from "../src/status/view";

function report(orphaned = false): StatusReport {
  return {
    root: "/state",
    workspaces: [
      {
        alive: true,
        config: "/repo/one/quirks.config.ts",
        id: "ws1",
        lastSeen: null,
        pid: 123,
        root: "/repo/one",
        runs: {
          recent: [
            {
              createdAt: 1,
              id: "rn-1",
              orphaned,
              status: orphaned ? "running" : "complete",
              step: "guides",
            },
          ],
          total: 1,
        },
        schedules: [
          {
            kind: null,
            lastFinish: null,
            lastStatus: "complete",
            name: "guides",
            nextDue: null,
            running: 123,
          },
        ],
        sessions: 2,
      },
    ],
  };
}

async function frame(
  data: StatusReport,
  here?: string,
  width = 100
): Promise<string> {
  const setup = await createTestRenderer({ height: 40, width });
  try {
    setup.renderer.root.add(
      createStatusView(setup.renderer, { here, report: data })
    );
    await setup.renderOnce();
    return setup.captureCharFrame();
  } finally {
    setup.renderer.destroy();
  }
}

describe("OpenTUI status", () => {
  test("renders workspaces, schedules, runs and the current workspace", async () => {
    const output = await frame(report(), "ws1");
    for (const value of [
      "QUIRKS",
      "/repo/one (here)",
      "guides",
      "complete",
      "runs (1)",
      "rn-1",
    ]) {
      expect(output).toContain(value);
    }
    expect(output).not.toContain("orphaned");
  });

  test("marks orphaned runs and live locks", async () => {
    const output = await frame(report(true));
    expect(output).toContain("orphaned (pid gone)");
    expect(output).toContain("pid 123");
    expect(output).not.toContain("(here)");
  });

  test("renders an empty state at narrow terminal widths", async () => {
    expect(
      await frame({ root: "/nowhere", workspaces: [] }, undefined, 40)
    ).toContain("no workspaces under /nowhere");
  });

  test("provides the same status facts without a renderer for piped output", () => {
    const output = statusText(report(true), "ws1");
    expect(output).toContain("/repo/one (here)");
    expect(output).toContain("orphaned (pid gone)");
    expect(output).toContain("pid 123");
    expect(output).not.toContain("\u001b");
  });
});
