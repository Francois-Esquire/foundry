/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeasureTable } from "~/studio/measure-table";
import type { GlyphShape } from "~/typeface/reading";
import { TRIANGLE } from "../helpers/fixtures";

const RIGHT_BEARING_ROW = /Right bearing/;
const ADVANCE_ROW = /Advance/;
const POINTS_ROW = /Points/;

const SOURCE: GlyphShape = { advance: 1000, outline: TRIANGLE };
const EDIT: GlyphShape = { advance: 1080, outline: TRIANGLE };

const advanceField = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: "Advance, in font units",
  });

afterEach(cleanup);

describe("MeasureTable", () => {
  it("prints each measure in the source and in the edit, with the difference", () => {
    render(<MeasureTable onCommit={vi.fn()} shape={EDIT} source={SOURCE} />);
    const row = screen.getByRole("row", { name: RIGHT_BEARING_ROW });
    expect(row.textContent).toContain("100");
    expect(row.textContent).toContain("+80");
    expect(advanceField().value).toBe("1080");
  });

  it("marks only the values the project changed, so the source font's own stay in ink", () => {
    render(<MeasureTable onCommit={vi.fn()} shape={EDIT} source={SOURCE} />);
    const field = (name: string) =>
      screen.getByRole("textbox", { name: `${name}, in font units` });
    // The advance went from 1000 to 1080, and the right bearing with it.
    expect(field("Advance").dataset.changed).toBe("true");
    expect(field("Right bearing").dataset.changed).toBe("true");
    expect(field("Left bearing").dataset.changed).toBe("false");
    const points = screen
      .getByRole("row", { name: POINTS_ROW })
      .querySelector("[data-changed]");
    expect(points?.getAttribute("data-changed")).toBe("false");
    expect(points?.classList.contains("ty-carbon")).toBe(false);
  });

  it("marks nothing for a glyph that is still as the source font has it", () => {
    render(<MeasureTable onCommit={vi.fn()} shape={SOURCE} source={SOURCE} />);
    expect(document.querySelectorAll('[data-changed="true"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-changed="false"]')).toHaveLength(4);
    expect(document.querySelector(".ty-carbon")).toBeNull();
  });

  it("marks every value of a glyph the project added, read only or not", () => {
    render(<MeasureTable shape={EDIT} />);
    expect(document.querySelectorAll('[data-changed="true"]')).toHaveLength(4);
    expect(document.querySelectorAll(".ty-carbon")).toHaveLength(4);
  });

  it("sets a measure once when Enter is pressed, and not again on leaving", () => {
    const onCommit = vi.fn();
    render(<MeasureTable onCommit={onCommit} shape={EDIT} source={SOURCE} />);
    fireEvent.change(advanceField(), { target: { value: "1200" } });
    fireEvent.keyDown(advanceField(), { key: "Enter" });
    fireEvent.blur(advanceField());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("advance", 1200);
  });

  it("sets a measure when the field is left", () => {
    const onCommit = vi.fn();
    render(<MeasureTable onCommit={onCommit} shape={EDIT} source={SOURCE} />);
    const left = screen.getByRole("textbox", {
      name: "Left bearing, in font units",
    });
    fireEvent.change(left, { target: { value: "-12" } });
    fireEvent.blur(left);
    expect(onCommit).toHaveBeenCalledWith("left", -12);
  });

  it("puts the number back on Escape and sets nothing", () => {
    const onCommit = vi.fn();
    render(<MeasureTable onCommit={onCommit} shape={EDIT} source={SOURCE} />);
    fireEvent.change(advanceField(), { target: { value: "5" } });
    fireEvent.keyDown(advanceField(), { key: "Escape" });
    fireEvent.blur(advanceField());
    expect(advanceField().value).toBe("1080");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("sets nothing for text that is not a whole number, or for the same number", () => {
    const onCommit = vi.fn();
    render(<MeasureTable onCommit={onCommit} shape={EDIT} source={SOURCE} />);
    for (const typed of ["wide", "10.5", "", "1080"]) {
      fireEvent.change(advanceField(), { target: { value: typed } });
      fireEvent.keyDown(advanceField(), { key: "Enter" });
    }
    expect(onCommit).not.toHaveBeenCalled();
    expect(advanceField().value).toBe("1080");
  });

  it("only prints the numbers of a glyph that cannot be edited", () => {
    render(<MeasureTable shape={EDIT} source={SOURCE} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByRole("row", { name: ADVANCE_ROW }).textContent
    ).toContain("1080");
  });
});
