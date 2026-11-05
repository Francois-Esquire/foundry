import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationDocument } from "../annotations/model.ts";
import {
  decodeDocument,
  encodeDocument,
  loadDocument,
  saveDocument,
  storageKey,
} from "../annotations/storage.ts";

function drawing(): AnnotationDocument {
  return {
    marks: [
      {
        anchor: { id: "the-model", x: 0.3, y: -0.2 },
        color: "#334455",
        id: "stroke-1",
        kind: "draw",
        points: [
          { x: 0, y: 0 },
          { x: 12, y: -8 },
        ],
        text: "",
      },
    ],
    version: 1,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("annotation document codec", () => {
  it("round-trips element anchors and CSS-pixel strokes independently of the UI", () => {
    const document = drawing();
    expect(decodeDocument(encodeDocument(document))).toEqual(document);
  });

  it.each([
    "not json",
    '{"version":2,"marks":[]}',
    '{"version":1,"marks":{}}',
    '{"version":1,"marks":[null]}',
  ])("rejects unsupported or malformed saved data: %s", (source) => {
    expect(decodeDocument(source)).toBeNull();
  });

  it("rejects duplicate identities and non-finite coordinates", () => {
    const document = drawing();
    const [mark] = document.marks;
    if (!mark) {
      throw new Error("Missing fixture stroke");
    }
    document.marks.push({ ...mark });
    expect(decodeDocument(JSON.stringify(document))).toBeNull();
    document.marks.pop();
    mark.anchor.x = Number.POSITIVE_INFINITY;
    expect(() => encodeDocument(document)).toThrow();
    expect(decodeDocument(JSON.stringify(document))).toBeNull();
  });

  it("rejects oversized strokes, text, and unsafe CSS color values", () => {
    for (const patch of [
      { points: Array.from({ length: 2001 }, () => ({ x: 0, y: 0 })) },
      { text: "x".repeat(2001) },
      { color: "url(https://example.com)" },
    ]) {
      const document = drawing();
      Object.assign(document.marks[0] ?? {}, patch);
      expect(decodeDocument(JSON.stringify(document))).toBeNull();
    }
  });

  it("bounds document size before parsing", () => {
    expect(decodeDocument(" ".repeat(8_000_001))).toBeNull();
  });
});

describe("page-local browser storage", () => {
  it("shares a key across section fragments, queries, and trailing slashes", () => {
    expect(storageKey("/foundry/marbles/?view=read#model")).toBe(
      storageKey("/foundry/marbles")
    );
    expect(storageKey("/")).not.toBe(storageKey("/foundry/marbles"));
  });

  it("restores drawings for their own route", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
      },
    });
    expect(saveDocument("/one/", drawing())).toBe(
      "Notes saved in this browser."
    );
    expect(loadDocument("/one").document).toEqual(drawing());
    expect(loadDocument("/two").document.marks).toEqual([]);
  });

  it("reports blocked reads and quota failures without claiming to save", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("Storage blocked");
        },
        setItem: () => {
          throw new Error("Quota exceeded");
        },
      },
    });
    expect(loadDocument("/one")).toEqual({
      document: { marks: [], version: 1 },
      message:
        "Browser storage is unavailable. Notes last until you leave this page.",
    });
    expect(saveDocument("/one", drawing())).toBe(
      "Notes could not be saved. Keep this page open to retain them."
    );
  });
});

describe("text-aware document validation", () => {
  function targetMark(): AnnotationDocument {
    const state = drawing();
    Object.assign(state.marks[0] ?? {}, {
      kind: "highlight",
      points: [],
      target: {
        segments: [
          {
            blockId: "model:p:0",
            end: 10,
            prefix: "some ",
            quote: "words",
            start: 5,
            suffix: " here",
          },
        ],
      },
    });
    return state;
  }

  it("preserves text targets through local serialization", () => {
    const state = targetMark();
    expect(decodeDocument(encodeDocument(state))).toEqual(state);
  });

  it("requires meaningful coherent text targets for semantic markup", () => {
    for (const target of [
      undefined,
      { segments: [] },
      {
        segments: [
          {
            blockId: "p",
            end: 7,
            prefix: "",
            quote: "words",
            start: 5,
            suffix: "",
          },
        ],
      },
      {
        segments: [
          {
            blockId: "p",
            end: 4,
            prefix: "",
            quote: "words",
            start: -1,
            suffix: "",
          },
        ],
      },
    ]) {
      const state = targetMark();
      Object.assign(state.marks[0] ?? {}, { target });
      expect(decodeDocument(JSON.stringify(state))).toBeNull();
    }
  });

  it("bounds text target segment count, context length, and total quote length", () => {
    const segment = {
      blockId: "p",
      end: 5,
      prefix: "",
      quote: "words",
      start: 0,
      suffix: "",
    };
    for (const segments of [
      Array.from({ length: 33 }, () => segment),
      [{ ...segment, prefix: "x".repeat(65) }],
      [{ ...segment, end: 8001, quote: "x".repeat(8001) }],
    ]) {
      const state = targetMark();
      Object.assign(state.marks[0] ?? {}, { target: { segments } });
      expect(decodeDocument(JSON.stringify(state))).toBeNull();
    }
  });
});
