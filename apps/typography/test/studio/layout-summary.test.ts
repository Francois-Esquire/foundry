import { describe, expect, it } from "vitest";
import type { LayoutSummary } from "~/packaging/building";
import { createSummaryLoader, substitutionLine } from "~/studio/layout-summary";

const SUMMARY: LayoutSummary = {
  anchorCount: 12,
  features: [],
  glyphNames: ["a"],
  kerningPairCount: 340,
};

const FONT = new Uint8Array([1, 2, 3]);

/** An engine whose answers the test settles by hand. */
const manualEngine = () => {
  const calls: {
    readonly faceIndex: number | undefined;
    readonly reject: (error: unknown) => void;
    readonly resolve: (summary: LayoutSummary) => void;
  }[] = [];
  return {
    calls,
    engine: {
      describeLayout: (_font: Uint8Array, faceIndex?: number) =>
        new Promise<LayoutSummary>((resolve, reject) => {
          calls.push({ faceIndex, reject, resolve });
        }),
    },
  };
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the layout summary loader", () => {
  it("asks for nothing until it is told to", () => {
    const { calls, engine } = manualEngine();
    expect(createSummaryLoader(engine).getState()).toEqual({ status: "idle" });
    expect(calls).toHaveLength(0);
  });

  it("is loading while the engine works, then ready with the summary", async () => {
    const { calls, engine } = manualEngine();
    const loader = createSummaryLoader(engine);
    const seen: string[] = [];
    loader.subscribe(() => seen.push(loader.getState().status));
    loader.load(FONT, 2);
    expect(calls[0]?.faceIndex).toBe(2);
    calls[0]?.resolve(SUMMARY);
    await settled();
    expect(seen).toEqual(["loading", "ready"]);
    expect(loader.getState()).toEqual({ status: "ready", summary: SUMMARY });
  });

  it("reports the engine's own message when it fails", async () => {
    const { calls, engine } = manualEngine();
    const loader = createSummaryLoader(engine);
    loader.load(FONT, 0);
    calls[0]?.reject(new Error("The font engine did not start. Try again."));
    await settled();
    expect(loader.getState()).toEqual({
      message: "The font engine did not start. Try again.",
      status: "failed",
    });
  });

  it("says the tables could not be read when the engine fails with no message", async () => {
    const { calls, engine } = manualEngine();
    const loader = createSummaryLoader(engine);
    loader.load(FONT, 0);
    calls[0]?.reject({ code: 7 });
    await settled();
    expect(loader.getState()).toEqual({
      message: "The font engine could not read the layout tables.",
      status: "failed",
    });
  });

  it("lets a newer request replace an older one that answers late", async () => {
    const { calls, engine } = manualEngine();
    const loader = createSummaryLoader(engine);
    loader.load(FONT, 0);
    loader.load(FONT, 1);
    calls[1]?.resolve(SUMMARY);
    calls[0]?.reject(new Error("too late"));
    await settled();
    expect(loader.getState()).toEqual({ status: "ready", summary: SUMMARY });
  });

  it("writes each kind of substitution as a short line", () => {
    expect(
      substitutionLine({ from: ["f", "i"], kind: "ligature", to: "f_i" })
    ).toBe("f i → f_i");
    expect(substitutionLine({ from: "a", kind: "single", to: "a.sc" })).toBe(
      "a → a.sc"
    );
    expect(
      substitutionLine({ from: "a", kind: "alternate", to: ["a.1", "a.2"] })
    ).toBe("a → a.1 or a.2");
    expect(
      substitutionLine({ from: "ffi", kind: "multiple", to: ["f", "f", "i"] })
    ).toBe("ffi → f f i");
  });
});
