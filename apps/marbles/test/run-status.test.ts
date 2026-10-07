import { describe, expect, it } from "vitest";
import {
  isActive,
  isPaused,
  isTerminal,
  statusDisplay,
} from "~/views/run-status";

describe("statusDisplay", () => {
  it("shows waiting on a person in the warning tone, over the runtime status", () => {
    expect(statusDisplay({ attention: "approval", status: "running" })).toEqual(
      { label: "Waiting for approval", tone: "warning" }
    );
    expect(statusDisplay({ attention: "question", status: "running" })).toEqual(
      { label: "Waiting for answer", tone: "warning" }
    );
  });

  it("colours running, complete, and failed, and leaves the rest neutral", () => {
    expect(
      ["running", "complete", "failed", "paused", "watching"].map(
        (status) => statusDisplay({ status }).tone
      )
    ).toEqual(["info", "success", "error", "neutral", "neutral"]);
    expect(statusDisplay({ status: "queued" }).label).toBe("queued");
  });
});

describe("status groups", () => {
  it("separates settled, trigger-holding, and resumable runs", () => {
    const statuses = [
      "queued",
      "running",
      "suspended",
      "paused",
      "complete",
      "failed",
      "cancelled",
    ];
    expect(statuses.filter(isTerminal)).toEqual([
      "complete",
      "failed",
      "cancelled",
    ]);
    expect(statuses.filter(isActive)).toEqual([
      "queued",
      "running",
      "suspended",
    ]);
    expect(statuses.filter(isPaused)).toEqual(["suspended", "paused"]);
  });
});
