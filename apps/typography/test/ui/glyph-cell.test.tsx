/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlyphCell, type GlyphCellState } from "~/ui/content/glyph-cell";
import { GlyphGrid } from "~/ui/content/glyph-grid";

afterEach(cleanup);

const STATES: readonly (readonly [GlyphCellState, string])[] = [
  ["source", "U+0915 Devanagari letter ka, in the source font"],
  ["edited", "U+0915 Devanagari letter ka, edited by hand"],
  ["candidate", "U+0915 Devanagari letter ka, candidate, not accepted"],
  ["missing", "U+0915 Devanagari letter ka, missing"],
];

describe("GlyphCell", () => {
  it.each(STATES)(
    "names the %s state and carries it as data",
    (state, name) => {
      render(
        <GlyphCell
          characterName="Devanagari letter ka"
          codePoint={0x09_15}
          onSelect={vi.fn()}
          state={state}
        >
          क
        </GlyphCell>
      );
      const cell = screen.getByRole("button", { name });
      expect(cell.dataset.state).toBe(state);
      expect(cell.textContent).toContain("0915");
    }
  );

  it("shows the letterform, or the crossed box when the character is missing", () => {
    const { rerender } = render(
      <GlyphCell codePoint={0x41} state="source">
        A
      </GlyphCell>
    );
    expect(screen.getByRole("img").textContent).toBe("A0041");
    expect(document.querySelector(".ty-tofu")).toBeNull();
    rerender(
      <GlyphCell codePoint={0x41} state="missing">
        A
      </GlyphCell>
    );
    expect(screen.getByRole("img").textContent).toBe("0041");
    expect(document.querySelector(".ty-tofu")).not.toBeNull();
  });

  it.each(STATES)("can be selected in the %s state", (state) => {
    render(
      <GlyphCell codePoint={0x41} onSelect={vi.fn()} selected state={state}>
        A
      </GlyphCell>
    );
    const cell = screen.getByRole("button");
    expect(cell.getAttribute("aria-pressed")).toBe("true");
    expect(cell.dataset.selected).toBe("true");
    expect(cell.dataset.state).toBe(state);
  });

  it("reports its code point when chosen", () => {
    const onSelect = vi.fn();
    render(
      <GlyphCell codePoint={0x1_f6_00} onSelect={onSelect} state="candidate">
        A
      </GlyphCell>
    );
    const cell = screen.getByRole("button", {
      name: "U+1F600, candidate, not accepted",
    });
    expect(cell.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(cell);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(0x1_f6_00);
  });

  it("is a still image, not a button, when nothing can be chosen", () => {
    render(
      <GlyphCell codePoint={0x41} state="edited">
        A
      </GlyphCell>
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByRole("img", { name: "U+0041, edited by hand" })
    ).toBeTruthy();
  });
});

describe("GlyphGrid", () => {
  it("moves focus between cells with the arrow keys, Home and End", () => {
    render(
      <GlyphGrid label="Capitals">
        {[0x41, 0x42, 0x43].map((codePoint) => (
          <GlyphCell
            codePoint={codePoint}
            key={codePoint}
            onSelect={vi.fn()}
            state="source"
          >
            {String.fromCodePoint(codePoint)}
          </GlyphCell>
        ))}
      </GlyphGrid>
    );
    const [a, b, c] = screen.getAllByRole("button");
    a?.focus();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "ArrowRight",
    });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "End" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "ArrowRight",
    });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Home" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "ArrowLeft",
    });
    expect(document.activeElement).toBe(a);
  });
});
