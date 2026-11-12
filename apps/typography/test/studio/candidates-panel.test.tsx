/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidatesPanel as Panel } from "~/studio/candidates-panel";
import { type Candidate, emptyProject } from "~/typeface/project";
import { describeFace, TRIANGLE } from "../helpers/fixtures";

const NOTHING_WAITING = /No candidates are waiting/;

const { metrics } = describeFace();

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  advance: 1000,
  characters: [0x9_15],
  faceId: "face",
  id: "ka",
  name: "ka-deva",
  outline: TRIANGLE,
  provenance: {
    createdAt: "2026-11-10T09:00:00.000Z",
    origin: "generated",
    recorded: true,
    runId: "run-1",
    strategy: "vector model",
  },

  ...overrides,
});

const CandidatesPanel = ({
  candidates,
  accepted = [],
  ...props
}: Omit<Parameters<typeof Panel>[0], "project"> & {
  readonly accepted?: readonly string[];
}) => {
  const project = {
    ...emptyProject(),
    candidates,
    head: accepted.length,
    revisions: accepted.map((id) => ({
      accepts: id,
      changes: [],
      createdAt: "now",
      id,
      label: "Accept",
    })),
  };
  return <Panel {...props} candidates={candidates} project={project} />;
};

afterEach(cleanup);

describe("CandidatesPanel", () => {
  it("says what belongs here when no candidate is waiting", () => {
    render(
      <CandidatesPanel
        candidates={[]}
        metrics={metrics}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.getByText(NOTHING_WAITING)).toBeTruthy();
  });

  it("shows where a candidate came from, and calls recorded output recorded", () => {
    render(
      <CandidatesPanel
        candidates={[candidate()]}
        metrics={metrics}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />
    );
    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("ka-deva, U+0915");
    expect(row.textContent).toContain(
      "Replayed from a recorded run of the vector model strategy. Not live model output."
    );
    expect(row.textContent).toContain("Accepting it adds a glyph to the face.");
    expect(
      row.querySelector(".ty-studio-candidate-frame")?.getAttribute("data-mark")
    ).toBe("unconfirmed");
    expect(row.querySelector(".ty-mark")?.getAttribute("data-kind")).toBe(
      "unconfirmed"
    );
    expect(row.textContent).toContain("Generated, not accepted");
  });

  it("frames an observed candidate in brackets, with the observed mark, not as a hand edit", () => {
    render(
      <CandidatesPanel
        candidates={[
          candidate({
            provenance: {
              basis: "observed",
              evidenceId: "photograph",
              origin: "reconstructed",
            },
          }),
        ]}
        metrics={metrics}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />
    );
    const row = screen.getByRole("listitem");
    const frame = row.querySelector(".ty-studio-candidate-frame");
    expect(frame?.getAttribute("data-mark")).toBe("observed");
    expect(frame?.querySelectorAll(".ty-brackets > span")).toHaveLength(4);
    expect(row.querySelector(".ty-mark")?.getAttribute("data-kind")).toBe(
      "observed"
    );
    expect(row.textContent).toContain("Observed in the evidence, not accepted");
  });

  it("hands the candidate to accept or reject", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const proposed = candidate();
    render(
      <CandidatesPanel
        candidates={[proposed]}
        metrics={metrics}
        onAccept={onAccept}
        onReject={onReject}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept ka-deva" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject ka-deva" }));
    expect(onAccept).toHaveBeenCalledWith(proposed);
    expect(onReject).toHaveBeenCalledWith(proposed);
  });

  it("lists only what is still proposed and counts what was settled", () => {
    render(
      <CandidatesPanel
        accepted={["a"]}
        candidates={[
          candidate({ id: "a", name: "kept" }),
          candidate({ id: "b", name: "dropped", rejected: true }),
          candidate({
            id: "c",
            name: "waiting",
            provenance: { origin: "manual" },
            replaces: { glyphId: 4, kind: "source" },
          }),
        ]}
        metrics={metrics}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain(
      "Drawn by hand. Accepting it redraws a glyph the face already has."
    );
    expect(screen.getByText("1 accepted, 1 rejected")).toBeTruthy();
  });
});
