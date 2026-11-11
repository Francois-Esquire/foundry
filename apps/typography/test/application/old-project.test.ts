/**
 * A project saved before verdicts, waiting runs and photographs had one
 * owner opens as the project it described. The fixture is a whole project
 * directory as the code at commit 6d123720 left it. Each case copies it
 * somewhere temporary and opens the copy: the fixture itself is never
 * opened, because saving rewrites a project in place.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactManager, artifactIdSchema } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import { afterEach, describe, expect, it } from "vitest";
import type { Inspection, WaitingCandidate } from "~/application/application";
import { openNodeApplication } from "~/application/node";
import { Refusal } from "~/lib/refusal";
import { countingIds } from "../helpers/fixed";
import { AT, FIXTURES } from "./helpers/project";

const FORMAT_1 = path.join(FIXTURES, "projects/format-1");
const PROJECT_TYPE = "application/vnd.foundry.typography.project";
const MODEL_OUTPUT_TYPE = "application/vnd.foundry.typography.model-output";

const FACE = "d636e4683231f931:0";
const HOLDOUT_RUN = "e9a9d3e1-02ff-42e7-adab-d57ada261d22";
const WAITING_RUN = "8d85949b-e0cd-4d9f-95c3-3e92f978e447";
const WAITING_OUTPUT =
  "model-output-e416f024cbd37889418ce215b45f73dc3d53495c4f0ef91debb026255482e83c";
const LATO =
  "source-font-d636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251";
const PHOTOGRAPH =
  "photograph-0632ad2f8152a6bf76775a4228d26cb9cbcb8ac49b779f245783b62e6c69d758";

const waiting = (
  code: string,
  name: string,
  text: string
): WaitingCandidate => ({
  faceId: FACE,
  id: `${HOLDOUT_RUN}:u+${code}`,
  name,
  origin: "generated",
  text,
  verdict: "pass",
});

const scope = (
  name: string,
  covered: number,
  total: number,
  script?: string
) => ({ candidates: 0, covered, name, script, total });

/**
 * What the code that wrote the file answered for it, written out from
 * `project.json`: the candidates still proposed with the verdicts of its
 * `verdicts` record, its one waiting run, its photograph and its head. The
 * coverage is Lato's own, which the file does not hold: the accepted R
 * redraws a glyph Lato has, so it adds to no script.
 */
const AS_FORMAT_1_ANSWERED: Inspection = {
  exports: [],
  faces: [
    {
      coverage: [
        scope("Latin", 1016, 1492, "Latn"),
        scope("Greek", 359, 518, "Grek"),
        scope("Cyrillic", 275, 508, "Cyrl"),
        scope("Symbols", 157, 6866),
        scope("Combining marks", 132, 692),
        scope("Digits and numbers", 88, 586),
        scope("Punctuation", 66, 399),
        scope("Shared letters", 30, 1039),
        scope("Spaces and controls", 23, 225),
        scope("Coptic", 14, 137, "Copt"),
        scope("Bopomofo", 2, 77, "Bopo"),
        scope("Devanagari", 0, 164, "Deva"),
      ],
      editable: true,
      faceId: FACE,
      label: "Lato Regular",
      sourceFont: LATO,
    },
  ],
  name: "Untitled project",
  photographs: [
    { artifactId: PHOTOGRAPH, fileName: "storefront-needed-things.jpg" },
  ],
  revisions: 1,
  waiting: {
    candidates: [
      waiting("0047", "uni0047", "G"),
      waiting("0061", "uni0061", "a"),
      waiting("0067", "uni0067", "g"),
      waiting("006b", "uni006B", "k"),
      waiting("0032", "uni0032", "2"),
    ],
    runs: [
      {
        faceId: FACE,
        glyphs: 18,
        modelOutput: WAITING_OUTPUT,
        runId: WAITING_RUN,
        script: "Devanagari",
      },
    ],
  },
};

interface SavedFile {
  readonly candidates: readonly Readonly<Record<string, unknown>>[];
  readonly format: number;
  readonly revisions: readonly Readonly<Record<string, unknown>>[];
  readonly [field: string]: unknown;
}

const copies: string[] = [];

afterEach(() => {
  for (const directory of copies.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A copy of the old project's directory, with the artifacts in it and a way to open it. */
const copyOfTheOldProject = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "typography-format-1-"));
  copies.push(directory);
  cpSync(path.join(FORMAT_1, "directory"), directory, { recursive: true });
  const artifacts = () =>
    new ArtifactManager({
      files: blobFiles(path.join(directory, "blobs")),
      store: new JsonArtifactStore({
        path: path.join(directory, "records.json"),
      }),
    });
  const newId = countingIds();
  return {
    artifacts,
    open: () =>
      openNodeApplication({ clock: () => new Date(AT), directory, newId }),
    /** The project file as the directory holds it now, byte for byte. */
    projectFile: async (): Promise<Uint8Array> => {
      const store = artifacts();
      const [project] = (await store.list({ type: PROJECT_TYPE })).items;
      const file =
        project?.content &&
        (await store.readFile(project.content.id, "project.json"));
      if (!file) {
        throw new Error("The copy holds no project file.");
      }
      return file.blob;
    },
  };
};

const parsed = (bytes: Uint8Array): SavedFile =>
  JSON.parse(new TextDecoder().decode(bytes));

const OLD_FILE = readFileSync(path.join(FORMAT_1, "project.json"));
const old = parsed(OLD_FILE);

describe("B5: a project saved in format 1", () => {
  it("is the file the fixture says it is", async () => {
    const { projectFile } = copyOfTheOldProject();
    expect(Buffer.from(await projectFile()).equals(OLD_FILE)).toBe(true);
    expect(old.format).toBe(1);
  });

  it("opens to the project it described, and answers inspect as format 1 did", async () => {
    const { open } = copyOfTheOldProject();
    const app = await open();
    expect(app.inspect()).toEqual(AS_FORMAT_1_ANSWERED);
    const { project } = app.workspace.getState();
    // The same revisions, ids and times, and the same candidates in the
    // same standing: one accepted, five proposed.
    expect(project.revisions).toEqual(old.revisions);
    expect(project.head).toBe(1);
    expect(project.candidates.map(({ status }) => status)).toEqual([
      "accepted",
      ...Array.from({ length: 5 }, () => "proposed"),
    ]);
    expect(
      project.candidates.map(({ verdict: _verdict, ...candidate }) => candidate)
    ).toEqual(old.candidates);
    // All six verdicts land, the accepted candidate's too.
    expect(
      Object.fromEntries(
        project.candidates.map(({ id, verdict }) => [id, verdict])
      )
    ).toEqual(old.verdicts);
    expect(Object.keys(old.verdicts as object)).toHaveLength(6);
    await app.close();
  });

  it("accepts its waiting run as one revision, from the change set format 1 kept", async () => {
    const { open } = copyOfTheOldProject();
    const app = await open();
    const accepted = await app.accept({ run: WAITING_RUN });
    expect(accepted).toEqual({ accepted: 18, revisions: 2 });
    const { project } = app.workspace.getState();
    expect(project.revisions.at(-1)?.label).toBe("Add a Devanagari subset");
    expect(project.revisions.at(-1)?.changes).toHaveLength(19);
    expect(app.inspect().waiting.runs).toEqual([]);
    await app.close();
  });

  it("is rewritten in format 2 at its first save, and that file opens deep-equal", async () => {
    const { open, projectFile } = copyOfTheOldProject();
    const app = await open();
    const before = app.workspace.getState().project;
    const inspected = app.inspect();
    await app.save();
    await app.close();

    const saved = parsed(await projectFile());
    expect(saved.format).toBe(2);
    expect(saved).not.toHaveProperty("verdicts");
    expect(saved).not.toHaveProperty("waitingRuns");
    expect(saved.candidates.map(({ verdict }) => verdict)).toEqual(
      Array.from({ length: 6 }, () => "pass")
    );
    // The run is in the file with its changes: the artifact is not read again.
    expect(saved.runs).toEqual([
      expect.objectContaining({
        faceId: FACE,
        glyphs: 18,
        modelOutput: WAITING_OUTPUT,
        runId: WAITING_RUN,
        script: "Devanagari",
      }),
    ]);
    expect(
      (saved.runs as readonly { readonly changes: unknown[] }[])[0]?.changes
    ).toHaveLength(19);
    // The photograph's record keeps its three fields.
    expect(saved.photographs).toEqual(old.photographs);

    const again = await open();
    expect(again.workspace.getState().project).toEqual(before);
    expect(again.inspect()).toEqual(inspected);
    expect(again.inspect()).toEqual(AS_FORMAT_1_ANSWERED);
    await again.close();
  });

  /** Puts another artifact where the waiting run's model output was, holding the files given. */
  const replaced =
    (entries: Readonly<Record<string, { readonly bytes: string }>>) =>
    async (store: ArtifactManager) => {
      const id = artifactIdSchema.parse(WAITING_OUTPUT);
      await store.delete(id);
      await store.create({
        entries,
        freeze: {},
        id,
        name: "2026-11-10-devanagari-subset",
        type: MODEL_OUTPUT_TYPE,
      });
    };

  it.each([
    [
      "is missing",
      async (store: ArtifactManager) => {
        await store.delete(artifactIdSchema.parse(WAITING_OUTPUT));
      },
    ],
    ["holds no change set", replaced({ "run.json": { bytes: "{}" } })],
    [
      "holds something that is not a change set",
      replaced({
        "change-set.json": { bytes: '{"kind":"glyph-removed"}' },
        "run.json": { bytes: "{}" },
      }),
    ],
  ])(
    "does not open when its waiting run's artifact %s, and leaves the file as it was",
    async (_what, spoil) => {
      const { artifacts, open, projectFile } = copyOfTheOldProject();
      await spoil(artifacts());
      const refused = await open().then(
        () => undefined,
        (error: unknown) => error
      );
      expect(refused).toBeInstanceOf(Refusal);
      // The sentence names the run and the artifact it could not be read from.
      expect((refused as Refusal).message).toContain(WAITING_RUN);
      expect((refused as Refusal).message).toContain(WAITING_OUTPUT);
      expect(Buffer.from(await projectFile()).equals(OLD_FILE)).toBe(true);
    }
  );
});
