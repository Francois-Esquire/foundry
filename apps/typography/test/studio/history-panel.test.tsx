/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryPanel } from "~/studio/history-panel";
import type { Revision } from "~/typeface/changes";

const REVISION_TWO = /Step to revision 2,/;

const revision = (id: string, label: string): Revision => ({
  changes: [],
  createdAt: "2026-11-10T09:00:00.000Z",
  id,
  label,
});

const REVISIONS = [
  revision("r1", "Move 1 point of a"),
  revision("r2", "Set the advance of a to 1300"),
  revision("r3", "Add a node to a"),
];

const noop = () => undefined;

const panel = (props: Partial<Parameters<typeof HistoryPanel>[0]> = {}) => (
  <HistoryPanel
    head={2}
    onCheckout={noop}
    onRedo={noop}
    onUndo={noop}
    revisions={REVISIONS}
    {...props}
  />
);

afterEach(cleanup);

describe("HistoryPanel", () => {
  it("lists the revisions newest first, down to the unchanged source", () => {
    render(panel());
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent)
    ).toEqual([
      "3Add a node to aundone",
      "2Set the advance of a to 1300",
      "1Move 1 point of a",
      "0Source fonts, unchanged",
    ]);
  });

  it("marks the revision the project stands at", () => {
    render(panel());
    expect(
      screen
        .getByRole("button", { name: REVISION_TWO })
        .getAttribute("aria-current")
    ).toBe("step");
  });

  it("steps to the revision that is chosen, undone ones and the source included", () => {
    const onCheckout = vi.fn();
    render(panel({ onCheckout }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Step to revision 3, Add a node to a, undone",
      })
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Step to the source fonts, unchanged",
      })
    );
    expect(onCheckout.mock.calls).toEqual([[3], [0]]);
  });

  it("shows an edit under way above the revisions", () => {
    render(panel({ head: 3, pending: "Move 2 points of a" }));
    const [first] = screen.getAllByRole("listitem");
    expect(first?.textContent).toBe("4Move 2 points of ain progress");
  });

  it("offers undo and redo only when there is somewhere to go", () => {
    const { rerender } = render(panel({ head: 0, revisions: [] }));
    const undo = () =>
      screen.getByRole<HTMLButtonElement>("button", { name: "Undo" });
    const redo = () =>
      screen.getByRole<HTMLButtonElement>("button", { name: "Redo" });
    expect(undo().disabled).toBe(true);
    expect(redo().disabled).toBe(true);
    rerender(panel({ head: 0, pending: "Move 1 point of a", revisions: [] }));
    expect(undo().disabled).toBe(false);
    rerender(panel({ head: 2 }));
    expect(undo().disabled).toBe(false);
    expect(redo().disabled).toBe(false);
    rerender(panel({ head: 3 }));
    expect(redo().disabled).toBe(true);
  });
});
