import { describe, expect, it } from "vitest";
import { directionRuns, paragraphDirection } from "~/typeface/direction";

const pieces = (text: string) =>
  directionRuns(text).map((run) => [
    text.slice(run.start, run.end),
    run.direction,
  ]);

describe("directionRuns", () => {
  it("keeps one direction in one run", () => {
    expect(pieces("Hamburg 2024")).toEqual([["Hamburg 2024", "ltr"]]);
    expect(pieces("שלום עולם")).toEqual([["שלום עולם", "rtl"]]);
    expect(directionRuns("")).toEqual([]);
  });

  it("puts a right-to-left word after the Latin before it", () => {
    expect(pieces("Hi שלום")).toEqual([
      ["Hi ", "ltr"],
      ["שלום", "rtl"],
    ]);
  });

  it("lists runs as they sit on the line when the paragraph reads right to left", () => {
    expect(paragraphDirection("שלום Hi")).toBe("rtl");
    expect(pieces("שלום Hi")).toEqual([
      ["Hi", "ltr"],
      ["שלום ", "rtl"],
    ]);
  });

  it("reads a number left to right inside right-to-left text", () => {
    expect(pieces("سنة 2024")).toEqual([
      ["2024", "ltr"],
      ["سنة ", "rtl"],
    ]);
    expect(paragraphDirection("2024 سنة")).toBe("rtl");
  });

  it("keeps a combining mark with its letter", () => {
    expect(pieces("נאָ Hi")).toEqual([
      ["Hi", "ltr"],
      ["נאָ ", "rtl"],
    ]);
    expect(pieces("कि")).toEqual([["कि", "ltr"]]);
  });

  it("takes a base direction when one is given", () => {
    expect(directionRuns("Hi שלום", "rtl").map((run) => run.direction)).toEqual(
      ["rtl", "ltr"]
    );
  });
});
