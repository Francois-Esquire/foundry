import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isKnownLink,
  loadDocument,
  loadPrevious,
  rememberLink,
  saveDocument,
  savePrevious,
  storageKey,
} from "../../../components/annotations/storage.ts";
import { drawingDocument as drawing } from "../../helpers/annotation-fixtures.ts";

afterEach(() => vi.unstubAllGlobals());

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
    expect(saveDocument("/one/", drawing())).toEqual({
      message: "Notes saved in this browser.",
      saved: true,
    });
    expect(loadDocument("/one")).toMatchObject({
      document: drawing(),
      status: "restored",
    });
    expect(loadDocument("/two")).toMatchObject({
      document: { marks: [] },
      status: "empty",
    });
    data.set(storageKey("/three"), "{broken");
    expect(loadDocument("/three").status).toBe("unreadable");
  });

  it("keeps link provenance and one previous copy per page", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
      },
    });
    expect(isKnownLink("/one/", "1g.payload")).toBe(false);
    rememberLink("/one?view=read#two", "1g.payload");
    expect(isKnownLink("/one", "1g.payload")).toBe(true);
    expect(isKnownLink("/one", "1g.other")).toBe(false);
    expect(isKnownLink("/two", "1g.payload")).toBe(false);
    for (let index = 0; index < 250; index += 1) {
      rememberLink("/one", `1r.${index}`);
    }
    expect(isKnownLink("/one", "1r.249")).toBe(true);
    expect(isKnownLink("/one", "1g.payload")).toBe(false);
    expect(loadPrevious("/one")).toBeNull();
    expect(savePrevious("/one/", drawing())).toBe(true);
    expect(loadPrevious("/one")).toEqual(drawing());
    expect(loadDocument("/one").status).toBe("empty");
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
      status: "unavailable",
    });
    expect(saveDocument("/one", drawing())).toEqual({
      message: "Notes could not be saved. Keep this page open to retain them.",
      saved: false,
    });
    expect(savePrevious("/one", drawing())).toBe(false);
    expect(loadPrevious("/one")).toBeNull();
    expect(isKnownLink("/one", "1g.payload")).toBe(false);
    expect(() => rememberLink("/one", "1g.payload")).not.toThrow();
  });
});
