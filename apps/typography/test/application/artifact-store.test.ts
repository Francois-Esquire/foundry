/** The formats the store owns: the change set format 1 kept with a waiting run, and how often a file name was exported. */
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "~/application/artifact-store";
import type { BuiltFont } from "~/export/build-run";
import { Refusal } from "~/lib/refusal";
import { addedGlyph, type Change, sourceGlyph } from "~/typeface/changes";
import { EMPTY_OUTLINE } from "~/typeface/outline";
import { FIXED_TIME } from "../helpers/fixed";
import { TRIANGLE } from "../helpers/fixtures";

const NOT_A_CHANGE_SET = /holds no change set this version of the app can read/;

const text = (value: string) => new TextEncoder().encode(value);

const RUN_FILES = new Map([["run.json", text('{"run":"recorded"}')]]);

const CHANGES: readonly Change[] = [
  {
    faceId: "face",
    glyph: {
      advance: 600,
      characters: [0x09_15],
      key: "ka",
      name: "ka-deva",
      outline: TRIANGLE,
      provenance: { origin: "manual" },
    },
    kind: "glyph-added",
  },
  {
    faceId: "face",
    glyph: sourceGlyph(4),
    kind: "outline-replaced",
    outline: EMPTY_OUTLINE,
  },
  {
    advance: 512,
    faceId: "face",
    glyph: addedGlyph("ka"),
    kind: "advance-changed",
  },
  { faceId: "face", key: "ka", kind: "glyph-removed" },
  {
    code: "feature akhn { sub ka-deva by ka-deva; } akhn;",
    description: "Conjuncts",
    faceId: "face",
    kind: "features-added",
  },
];

const memoryStore = () =>
  createArtifactStore(
    new ArtifactManager({ store: new InMemoryArtifactStore() })
  );

describe("a waiting run of a project saved in format 1", () => {
  it("is read back, as the same changes, from the change set format 1 kept beside its files", async () => {
    const store = memoryStore();
    const artifactId = await store.keepModelOutput(
      "a-run",
      new Map([
        ...RUN_FILES,
        ["change-set.json", text(JSON.stringify(CHANGES))],
      ])
    );
    expect(await store.readWaitingRun(artifactId)).toEqual(CHANGES);
    // The run's own files are beside the change set, untouched.
    expect(await store.read({ artifactId }, "run.json")).toEqual(
      RUN_FILES.get("run.json")
    );
  });

  it("refuses model output that was kept without a change set", async () => {
    const store = memoryStore();
    const artifactId = await store.keepModelOutput("a-run", RUN_FILES);
    await expect(store.readWaitingRun(artifactId)).rejects.toThrow(Refusal);
  });

  it.each([
    ["text that is not JSON", "not json"],
    ["a document that is not a list", '{"kind":"glyph-removed"}'],
    [
      "a change of a kind there is none of",
      '[{"faceId":"face","kind":"glyph-renamed"}]',
    ],
    ["a change with no face", '[{"key":"ka","kind":"glyph-removed"}]'],
    [
      "a change that lacks what its kind carries",
      '[{"faceId":"face","glyph":{"kind":"source"},"kind":"advance-changed"}]',
    ],
  ])("refuses %s in place of a change set", async (_what, kept) => {
    const store = memoryStore();
    const artifactId = await store.keepModelOutput(
      "a-run",
      new Map([...RUN_FILES, ["change-set.json", text(kept)]])
    );
    await expect(store.readWaitingRun(artifactId)).rejects.toThrow(
      NOT_A_CHANGE_SET
    );
  });
});

describe("an export", () => {
  const built = (bytes: Uint8Array): BuiltFont => ({
    builtAt: FIXED_TIME,
    bytes,
    faceId: "face",
    fileName: "AtlasSans-Regular.ttf",
    id: "built-1",
    notes: [],
    report: { checks: [], passed: true },
    request: {
      added: [],
      faceIndex: 0,
      featureCode: [],
      overrides: new Map(),
      source: Uint8Array.of(0, 1, 0, 0),
    },
    revisionId: undefined,
    samples: [],
  });

  it("answers with the export as it is kept: its artifact, this version and how many there are", async () => {
    const store = memoryStore();
    const first = await store.keepExport(undefined, built(Uint8Array.of(1)));
    expect(first).toMatchObject({
      fileName: "AtlasSans-Regular.ttf",
      versions: 1,
    });
    const second = await store.keepExport(
      first.artifactId,
      built(Uint8Array.of(2))
    );
    expect(second).toMatchObject({
      artifactId: first.artifactId,
      fileName: "AtlasSans-Regular.ttf",
      versions: 2,
    });
    expect(second.contentId).not.toBe(first.contentId);
    // The count is the store's own: listing the exports afresh says the same.
    const { contentId: _contentId, ...kept } = second;
    expect(await store.exports()).toEqual([kept]);
  });
});
