/** @vitest-environment happy-dom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignFrame } from "~/ui/content/design-frame";
import { Mark } from "~/ui/symbols/mark";

afterEach(cleanup);

const drawingOf = (container: HTMLElement) => container.querySelector("svg");

describe("Mark", () => {
  it("has a mark for lettering observed in evidence, drawn in carbon", () => {
    const { container } = render(<Mark kind="observed" />);
    expect(container.textContent).toBe("Observed in the evidence");
    expect(container.querySelector(".ty-mark")?.getAttribute("data-kind")).toBe(
      "observed"
    );
    expect(
      drawingOf(container)?.classList.contains("ty-mark-drawing-carbon")
    ).toBe(true);
  });

  it("draws the observed mark as four corners, not the closed box of an edit", () => {
    const observed = drawingOf(render(<Mark kind="observed" />).container);
    const edited = drawingOf(render(<Mark kind="edited" />).container);
    const pathOf = (drawing: Element | null | undefined) =>
      drawing?.querySelector("path")?.getAttribute("d") ?? "";
    expect(pathOf(observed).match(/M/g)).toHaveLength(4);
    expect(pathOf(observed)).not.toContain("Z");
    expect(pathOf(edited)).toContain("Z");
  });

  it("keeps ink for the marks of the source font", () => {
    for (const kind of ["source", "missing", "revisions"] as const) {
      const { container } = render(<Mark kind={kind} />);
      expect(
        drawingOf(container)?.classList.contains("ty-mark-drawing-carbon")
      ).toBe(false);
      cleanup();
    }
  });

  it("prints the words it is given in place of its standard name", () => {
    const { container } = render(
      <Mark kind="edited">Observed in the evidence, accepted</Mark>
    );
    expect(container.textContent).toBe("Observed in the evidence, accepted");
  });
});

describe("DesignFrame", () => {
  it("carries the mark as data and draws brackets only for observed work", () => {
    const { container, rerender } = render(
      <DesignFrame mark="observed">A</DesignFrame>
    );
    const frame = () => container.querySelector(".ty-design-frame");
    expect(frame()?.getAttribute("data-mark")).toBe("observed");
    expect(container.querySelectorAll(".ty-brackets > span")).toHaveLength(4);
    for (const mark of ["edited", "unconfirmed", "none"] as const) {
      rerender(<DesignFrame mark={mark}>A</DesignFrame>);
      expect(frame()?.getAttribute("data-mark")).toBe(mark);
      expect(container.querySelector(".ty-brackets")).toBeNull();
    }
  });
});
