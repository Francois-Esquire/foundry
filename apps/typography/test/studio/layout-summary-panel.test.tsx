/** @vitest-environment happy-dom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LayoutSummary } from "~/packaging/building";
import { LayoutSummaryPanel } from "~/studio/layout-summary-panel";

const LIGA_ROW = /liga/;
const SOURCE_ONLY_NOTE = /Feature code added in the project is not included/;

const FONT = new Uint8Array([0, 1, 0, 0]);

const SUMMARY: LayoutSummary = {
  anchorCount: 272,
  features: [
    {
      lookupCount: 1,
      scripts: ["DFLT", "latn"],
      substitutions: [
        { from: ["f", "i"], kind: "ligature", to: "f_i" },
        { from: ["f", "l"], kind: "ligature", to: "f_l" },
      ],
      table: "GSUB",
      tag: "liga",
      truncated: true,
    },
    {
      lookupCount: 3,
      scripts: ["latn"],
      substitutions: [],
      table: "GPOS",
      tag: "kern",
      truncated: false,
    },
  ],
  glyphNames: [],
  kerningPairCount: 1,
};

/** A builder whose answers the test settles by hand, as a fake of the font engine. */
const manualBuilder = () => {
  const calls: {
    readonly faceIndex: number | undefined;
    readonly font: Uint8Array;
    readonly reject: (error: Error) => void;
    readonly resolve: (summary: LayoutSummary) => void;
  }[] = [];
  return {
    builder: {
      describeLayout: (font: Uint8Array, faceIndex?: number) =>
        new Promise<LayoutSummary>((resolve, reject) => {
          calls.push({ faceIndex, font, reject, resolve });
        }),
    },
    calls,
  };
};

afterEach(cleanup);

describe("LayoutSummaryPanel", () => {
  it("asks the engine for nothing until the summary is asked for", () => {
    const { builder, calls } = manualBuilder();
    render(
      <LayoutSummaryPanel
        builder={builder}
        engineStatus="idle"
        faceIndex={0}
        font={FONT}
      />
    );
    expect(calls).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Load layout summary" })
    ).toBeTruthy();
  });

  it("says the engine is starting, then that it is reading, then shows the summary", async () => {
    const { builder, calls } = manualBuilder();
    const panel = (engineStatus: "ready" | "starting") => (
      <LayoutSummaryPanel
        builder={builder}
        engineStatus={engineStatus}
        faceIndex={1}
        font={FONT}
      />
    );
    const { rerender } = render(panel("starting"));
    fireEvent.click(
      screen.getByRole("button", { name: "Load layout summary" })
    );
    expect(calls[0]?.font).toBe(FONT);
    expect(calls[0]?.faceIndex).toBe(1);
    expect(screen.getByText("Starting the font engine")).toBeTruthy();
    rerender(panel("ready"));
    expect(screen.getByText("Reading the layout tables")).toBeTruthy();
    await act(async () => {
      calls[0]?.resolve(SUMMARY);
      await Promise.resolve();
    });
    expect(
      screen.getByText("2 features, 1 kerning pair, 272 anchors")
    ).toBeTruthy();
    const liga = screen.getByRole("row", { name: LIGA_ROW });
    expect(liga.textContent).toContain("DFLT, latn");
    expect(liga.textContent).toContain("f i → f_i, f l → f_l, and more");
    expect(screen.getByText(SOURCE_ONLY_NOTE)).toBeTruthy();
  });

  it("names the problem when the engine fails, and tries again when asked", async () => {
    const { builder, calls } = manualBuilder();
    render(
      <LayoutSummaryPanel
        builder={builder}
        engineStatus="failed"
        faceIndex={0}
        font={FONT}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Load layout summary" })
    );
    await act(async () => {
      calls[0]?.reject(
        new Error("The font engine did not start (no network). Try again.")
      );
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "The layout summary could not be loaded. The font engine did not start (no network). Try again."
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(calls).toHaveLength(2);
  });
});
