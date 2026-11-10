import { describe, expect, it } from "vitest";
import { commandForKey, type KeyPress } from "~/studio/canvas-keys";

const press = (key: string, held: Partial<KeyPress> = {}): KeyPress => ({
  altKey: false,
  ctrlKey: false,
  key,
  metaKey: false,
  shiftKey: false,
  ...held,
});

describe("keys on the glyph drawing", () => {
  it("nudges one unit with an arrow, up being up in the font", () => {
    expect(commandForKey(press("ArrowUp"))).toEqual({
      dx: 0,
      dy: 1,
      kind: "nudge",
    });
    expect(commandForKey(press("ArrowLeft"))).toEqual({
      dx: -1,
      dy: 0,
      kind: "nudge",
    });
  });

  it("nudges ten units with Shift", () => {
    expect(commandForKey(press("ArrowRight", { shiftKey: true }))).toEqual({
      dx: 10,
      dy: 0,
      kind: "nudge",
    });
  });

  it("pans the drawing with Alt, up being up on screen", () => {
    expect(commandForKey(press("ArrowUp", { altKey: true }))).toEqual({
      dx: 0,
      dy: -40,
      kind: "pan",
    });
  });

  it("steps through the points with Page Down and Page Up", () => {
    expect(commandForKey(press("PageDown"))).toEqual({
      direction: 1,
      extend: false,
      kind: "step",
    });
    expect(commandForKey(press("PageUp", { shiftKey: true }))).toEqual({
      direction: -1,
      extend: true,
      kind: "step",
    });
  });

  it("undoes and redoes with the command key on either platform", () => {
    expect(commandForKey(press("z", { metaKey: true }))).toEqual({
      kind: "undo",
    });
    expect(
      commandForKey(press("Z", { ctrlKey: true, shiftKey: true }))
    ).toEqual({ kind: "redo" });
    expect(commandForKey(press("y", { ctrlKey: true }))).toEqual({
      kind: "redo",
    });
    expect(commandForKey(press("a", { metaKey: true }))).toEqual({
      kind: "select-all",
    });
  });

  it("deletes, clears, zooms and fits", () => {
    expect(commandForKey(press("Backspace"))).toEqual({ kind: "delete" });
    expect(commandForKey(press("Escape"))).toEqual({ kind: "clear" });
    expect(commandForKey(press("+"))).toEqual({ factor: 1.25, kind: "zoom" });
    expect(commandForKey(press("-"))).toEqual({ factor: 0.8, kind: "zoom" });
    expect(commandForKey(press("0"))).toEqual({ kind: "fit" });
  });

  it("leaves other keys, and browser shortcuts, alone", () => {
    expect(commandForKey(press("Tab"))).toBeUndefined();
    expect(commandForKey(press("q"))).toBeUndefined();
    expect(commandForKey(press("r", { metaKey: true }))).toBeUndefined();
    expect(
      commandForKey(press("ArrowLeft", { metaKey: true }))
    ).toBeUndefined();
  });
});
