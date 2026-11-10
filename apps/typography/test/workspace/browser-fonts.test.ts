import { afterEach, describe, expect, it, vi } from "vitest";
import {
  documentFontRegistry,
  type FontRegistry,
  followSourceFonts,
  fontVariationSettings,
} from "~/workspace/browser-fonts";
import { fontBytes } from "../helpers/fixtures";
import { collectionOf } from "../helpers/font-files";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

const fakeRegistry = () => {
  const registered = new Map<string, Uint8Array>();
  const registry: FontRegistry = {
    add: (family, bytes) => {
      registered.set(family, bytes);
    },
    remove: (family) => {
      registered.delete(family);
    },
  };
  return { registered, registry };
};

describe("followSourceFonts", () => {
  it("registers each source font under its own family, with the imported bytes", async () => {
    const workspace = testWorkspace();
    const { registered, registry } = fakeRegistry();
    const earlier = fixtureFile("hebrew");
    const hebrew = await importOne(workspace, earlier);
    const fonts = followSourceFonts(workspace, registry);
    const later = fixtureFile("sofia");
    const sofia = await importOne(workspace, later);

    const hebrewFamily = fonts.familyFor(hebrew.faceId);
    const sofiaFamily = fonts.familyFor(sofia.faceId);
    expect(hebrewFamily).toBe(
      `Typography Source ${hebrew.sourceId.slice(0, 12)}`
    );
    expect(sofiaFamily).not.toBe(hebrewFamily);
    expect([...registered.keys()]).toEqual([hebrewFamily, sofiaFamily]);
    expect(registered.get(hebrewFamily ?? "")).toBe(earlier.bytes);
    expect(registered.get(sofiaFamily ?? "")).toBe(later.bytes);
  });

  it("gives a pinned instance the family of its variable face", async () => {
    const workspace = testWorkspace();
    const { registered, registry } = fakeRegistry();
    const fonts = followSourceFonts(workspace, registry);
    const sofia = await importOne(workspace, fixtureFile("sofia"));
    const pinned = workspace.pinInstance(sofia.faceId, { wght: 700 }, "Bold");
    if (!pinned.ok) {
      throw new Error(pinned.notice.message);
    }
    expect(fonts.familyFor(pinned.value.id)).toBe(
      fonts.familyFor(sofia.faceId)
    );
    expect(registered.size).toBe(1);
    expect(fontVariationSettings(pinned.value.pinned?.location ?? {})).toBe(
      '"wght" 700'
    );
  });

  it("removes the registration when the source font is removed", async () => {
    const workspace = testWorkspace();
    const { registered, registry } = fakeRegistry();
    const fonts = followSourceFonts(workspace, registry);
    const hebrew = await importOne(workspace, fixtureFile("hebrew"));
    const sofia = await importOne(workspace, fixtureFile("sofia"));
    const sofiaFamily = fonts.familyFor(sofia.faceId);

    workspace.removeSource(hebrew.sourceId);
    expect([...registered.keys()]).toEqual([sofiaFamily]);
    expect(fonts.familyFor(hebrew.faceId)).toBeUndefined();
    expect(fonts.familyFor("unknown")).toBeUndefined();
  });

  it("gives only the first face of a font collection a family", async () => {
    const workspace = testWorkspace();
    const { registered, registry } = fakeRegistry();
    const fonts = followSourceFonts(workspace, registry);
    const { faceIds } = await importOne(workspace, {
      bytes: collectionOf([fontBytes("hebrew"), fontBytes("postscript")]),
      name: "pair.ttc",
    });
    expect(registered.size).toBe(1);
    expect(fonts.familyFor(faceIds[0] ?? "")).toBeDefined();
    expect(fonts.familyFor(faceIds[1] ?? "")).toBeUndefined();
  });

  it("removes everything and stops following when stopped", async () => {
    const workspace = testWorkspace();
    const { registered, registry } = fakeRegistry();
    const fonts = followSourceFonts(workspace, registry);
    const hebrew = await importOne(workspace, fixtureFile("hebrew"));
    fonts.stop();
    expect(registered.size).toBe(0);
    expect(fonts.familyFor(hebrew.faceId)).toBeUndefined();
    await importOne(workspace, fixtureFile("sofia"));
    expect(registered.size).toBe(0);
  });
});

describe("fontVariationSettings", () => {
  it("writes a location as a CSS value", () => {
    expect(fontVariationSettings({ wdth: 87.5, wght: 700 })).toBe(
      '"wdth" 87.5, "wght" 700'
    );
    expect(fontVariationSettings({})).toBe("normal");
  });
});

describe("documentFontRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFontFace = (load: () => Promise<unknown>) => {
    const built: { family: string; source: unknown }[] = [];
    class FakeFontFace {
      readonly family: string;
      readonly load = load;
      constructor(family: string, source: unknown) {
        this.family = family;
        built.push({ family, source });
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    return built;
  };

  it("builds a font face from the bytes and adds it to the set", () => {
    const built = stubFontFace(() => Promise.resolve());
    const set = new Set<FontFace>();
    const registry = documentFontRegistry(set as unknown as FontFaceSet);
    const bytes = new Uint8Array([1, 2, 3]);

    registry.add("Typography Source abc", bytes);
    expect(built).toEqual([{ family: "Typography Source abc", source: bytes }]);
    expect([...set].map((face) => face.family)).toEqual([
      "Typography Source abc",
    ]);

    registry.remove("Typography Source abc");
    registry.remove("never added");
    expect(set.size).toBe(0);
  });

  it("drops a font the browser refuses to load", async () => {
    stubFontFace(() => Promise.reject(new Error("refused")));
    const set = new Set<FontFace>();
    const registry = documentFontRegistry(set as unknown as FontFaceSet);
    registry.add("Typography Source bad", new Uint8Array([0]));
    expect(set.size).toBe(1);
    await vi.waitFor(() => expect(set.size).toBe(0));
  });
});
