/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FamilyRunPanel } from "~/generate/family/family-run-panel";
import type {
  FamilyActivity,
  WeightLine,
} from "~/generate/family/family-session";

const PLANNED: readonly WeightLine[] = [
  { name: "Light", status: "waiting", weight: 300 },
  { name: "Regular", status: "waiting", weight: 400 },
  { name: "ExtraBold", status: "waiting", weight: 800 },
];

const show = (activity?: FamilyActivity, ready = true) =>
  render(
    <FamilyRunPanel
      activity={activity}
      label="Generate 6 glyphs at 3 weights"
      onRun={vi.fn()}
      onStop={vi.fn()}
      planned={PLANNED}
      readiness={
        ready ? { ready: true } : { ready: false, reason: "Choose a key." }
      }
    />
  );

const statuses = () =>
  screen
    .getByRole("list", { name: "Weights of the run" })
    .querySelectorAll("li");

afterEach(cleanup);

describe("the run panel of a coordinated run", () => {
  it("lists the weights a run would work at before any run", () => {
    show();
    expect(
      [...statuses()].map((row) => [
        row.getAttribute("data-weight"),
        row.getAttribute("data-weight-status"),
      ])
    ).toEqual([
      ["300", "waiting"],
      ["400", "waiting"],
      ["800", "waiting"],
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Generate 6 glyphs at 3 weights" })
        .hasAttribute("disabled")
    ).toBe(false);
  });

  it("says why a run cannot start", () => {
    show(undefined, false);
    expect(screen.getByText("Choose a key.")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Generate 6 glyphs at 3 weights" })
        .hasAttribute("disabled")
    ).toBe(true);
  });

  it("names the weight being worked on while a run is under way", () => {
    show({
      faceId: "face",
      lines: [
        { name: "Light", status: "generated", weight: 300 },
        { name: "Regular", status: "running", weight: 400 },
        { name: "ExtraBold", status: "waiting", weight: 800 },
      ],
      status: "running",
    });
    expect(
      screen.getByText("Generating Regular, weight 400, 2 of 3")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop the run" })).toBeTruthy();
  });

  it("names a failed weight with its reason, and says what the others kept", () => {
    show({
      faceId: "face",
      lines: [
        {
          detail: "6 candidates.",
          name: "Light",
          status: "generated",
          weight: 300,
        },
        {
          detail: "The model answered 503.",
          name: "Regular",
          status: "failed",
          weight: 400,
        },
        {
          detail: "Not started, because an earlier weight failed.",
          name: "ExtraBold",
          status: "not-run",
          weight: 800,
        },
      ],
      status: "finished",
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Regular, weight 400, failed. The model answered 503. Light keeps what it made, and it is on the board below. ExtraBold was not started, so nothing more was spent. Change the request or the strategy, then run again."
    );
    expect(
      [...statuses()].map((row) => row.getAttribute("data-weight-status"))
    ).toEqual(["generated", "failed", "not-run"]);
  });

  it("says nothing was kept when the first weight failed", () => {
    show({
      faceId: "face",
      lines: [
        { detail: "No key.", name: "Light", status: "failed", weight: 300 },
        { name: "Regular", status: "not-run", weight: 400 },
        { name: "ExtraBold", status: "not-run", weight: 800 },
      ],
      status: "finished",
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Light, weight 300, failed. No key. No weight before it had made anything. Regular, ExtraBold were not started, so nothing more was spent."
    );
  });

  it("shows why a whole run came to nothing, over the planned weights", () => {
    show({
      faceId: "face",
      failure: "The run was stopped before it finished.",
      lines: [],
      status: "failed",
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "The run was stopped before it finished."
    );
    expect(statuses()).toHaveLength(3);
  });
});
