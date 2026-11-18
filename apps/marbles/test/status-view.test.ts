import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, test } from "vitest";
import type { StatusReport } from "../src/status/model";
import { statusText } from "../src/status/text";
import { createStatusView } from "../src/status/view";

function report(orphaned = false): StatusReport {
  return {
    generations: [],
    process: null,
    root: "/state",
    workspaces: [
      {
        alive: true,
        artifacts: 3,
        config: "/repo/one/marbles.config.ts",
        host: "generation",
        hosted: true,
        id: "ws1",
        lastSeen: null,
        observers: [
          {
            behind: 0,
            failures: 0,
            lastError: null,
            missed: null,
            name: "notify",
            position: 4,
            retryAt: null,
            source: "tasks",
            stuckSince: null,
          },
          {
            behind: 3,
            failures: 2,
            lastError: "the webhook is down",
            missed: { from: 1, through: 1 },
            name: "deploy",
            position: 1,
            retryAt: Date.parse("2026-11-15T12:00:02.000Z"),
            source: "runs",
            stuckSince: null,
          },
          {
            behind: 1,
            failures: 1,
            lastError: "the handler did not finish within 300s",
            missed: null,
            name: "hung",
            position: 3,
            retryAt: Date.parse("2026-11-15T12:05:01.000Z"),
            source: "tasks",
            stuckSince: Date.parse("2026-11-15T12:00:00.000Z"),
          },
        ],
        pid: 123,
        recovery: {
          at: "2026-11-15T12:00:00.000Z",
          steps: [
            {
              detail: "1 process(es) stopped",
              outcome: "done",
              step: "processes",
            },
            {
              detail: "Error: disk is gone",
              outcome: "failed",
              step: "artifacts",
            },
          ],
        },
        root: "/repo/one",
        runs: {
          recent: [
            {
              createdAt: 1,
              id: "rn-1",
              orphaned,
              status: orphaned ? "running" : "complete",
              step: "guides",
              steps: [
                { name: "gather", status: "complete" },
                { name: "write", status: orphaned ? "running" : "complete" },
              ],
            },
            {
              createdAt: 0,
              id: "rn-0",
              orphaned: false,
              sharedFrom: "ws2",
              status: "complete",
              step: "review",
              steps: [],
            },
          ],
          total: 2,
        },
        schedules: [
          {
            key: "guides",
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
      "MARBLES",
      "/repo/one (here)",
      "guides",
      "complete",
      "runs (2)",
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
      await frame(
        { generations: [], process: null, root: "/nowhere", workspaces: [] },
        undefined,
        40
      )
    ).toContain("no workspaces under /nowhere");
  });

  test("provides the same status facts without a renderer for piped output", () => {
    const output = statusText(report(true), "ws1");
    expect(output).toContain("/repo/one (here)");
    expect(output).toContain("orphaned (pid gone)");
    expect(output).toContain("pid 123");
    expect(output).not.toContain("\u001b");
  });

  test("lists each run's steps as its detail, and marks a run shared from another workspace", () => {
    const output = statusText(report(), "ws1");
    expect(output).toContain("artifacts: 3");
    expect(output).toContain("  steps: gather [complete] · write [complete]");
    expect(output).toContain("review  [complete] shared from ws2");
  });
});

describe("the last recovery", () => {
  test("is shown step by step, a failed step counted first", () => {
    const text = statusText(report());
    expect(text).toContain(
      "last recovery: 2026-11-15T12:00:00.000Z · 1 step(s) failed"
    );
    expect(text).toContain("  processes  [done] 1 process(es) stopped");
    expect(text).toContain("  artifacts  [failed] Error: disk is gone");
    const none = report();
    const [only] = none.workspaces;
    expect(
      statusText({
        ...none,
        workspaces: [{ ...(only as NonNullable<typeof only>), recovery: null }],
      })
    ).toContain("last recovery: none recorded");
  });
});

describe("the observers", () => {
  test("are shown each with its place, a failing one with its error and next try, and what one missed", () => {
    const text = statusText(report());
    expect(text).toContain("observers");
    expect(text).toContain("notify (tasks)  [caught up] at 4");
    expect(text).toContain("deploy (runs)  [failing ×2] at 1");
    expect(text).toContain(
      "  the webhook is down · next try 2026-11-15T12:00:02.000Z"
    );
    expect(text).toContain("  missed 1 to 1: removed before it received them");
  });
});
