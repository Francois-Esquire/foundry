import { describe, expect, it } from "vitest";
import {
  emptyBoard,
  endStage,
  failBoard,
  followProgress,
  formatElapsed,
  startStage,
} from "~/generate/stage-board";

const statusOf = (board: ReturnType<typeof emptyBoard>, stage: string) =>
  board.find((line) => line.stage === stage)?.status;

describe("the stage board", () => {
  it("starts with analyse and plan ahead of the pipeline's stages, all waiting", () => {
    expect(
      emptyBoard()
        .slice(0, 3)
        .map((line) => line.stage)
    ).toEqual(["analyse", "plan", "generate"]);
    expect(emptyBoard().every((line) => line.status === "waiting")).toBe(true);
  });

  it("follows the runner's reports stage by stage", () => {
    let board = endStage(startStage(emptyBoard(), "analyse"), {
      detail: "Measured.",
      elapsedMs: 80,
      stage: "analyse",
      status: "finished",
    });
    board = followProgress(board, { stage: "generate", status: "started" });
    expect(statusOf(board, "generate")).toBe("running");
    board = followProgress(board, {
      detail: "One sheet.",
      elapsedMs: 12,
      stage: "generate",
      status: "finished",
    });
    board = followProgress(board, {
      detail: "Outlines, not a sheet.",
      stage: "extract",
      status: "skipped",
    });
    expect(board.slice(0, 4)).toEqual([
      {
        detail: "Measured.",
        elapsedMs: 80,
        stage: "analyse",
        status: "finished",
      },
      { stage: "plan", status: "waiting" },
      {
        detail: "One sheet.",
        elapsedMs: 12,
        stage: "generate",
        status: "finished",
      },
      {
        detail: "Outlines, not a sheet.",
        elapsedMs: undefined,
        stage: "extract",
        status: "skipped",
      },
    ]);
  });

  it("puts a failure on the stage that was running", () => {
    const running = followProgress(emptyBoard(), {
      stage: "extract",
      status: "started",
    });
    const { board, failure } = failBoard(running, "No decoder was given.");
    expect(failure).toEqual({
      reason: "No decoder was given.",
      stage: "extract",
    });
    expect(statusOf(board, "extract")).toBe("failed");
  });

  it("puts a failure on the first stage that never began, or on the one named", () => {
    const planned = endStage(emptyBoard(), {
      detail: "",
      elapsedMs: 0,
      stage: "analyse",
      status: "finished",
    });
    expect(failBoard(planned, "Stopped.").failure.stage).toBe("plan");
    expect(failBoard(planned, "Refused.", "integrate").failure.stage).toBe(
      "integrate"
    );
  });

  it("writes times as a person reads them", () => {
    expect(formatElapsed(0.24)).toBe("0.2 ms");
    expect(formatElapsed(0)).toBe("0 ms");
    expect(formatElapsed(38.4)).toBe("38 ms");
    expect(formatElapsed(9860)).toBe("9.9 s");
  });
});
