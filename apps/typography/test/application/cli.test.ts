/**
 * The command line, as a person calls it: one process a command, on one
 * project directory. Each call prints one JSON document, and whatever a
 * later call needs is on disk.
 *
 * The cases are one sequence. They run in order on one project directory,
 * and each starts from what the call before it left there.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Imported, Inspection } from "~/application/application";
import type {
  Accepted,
  ExportedFont,
  ExtensionRun,
} from "~/application/commands";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";

const APP = path.join(import.meta.dirname, "../..");
const COMMAND_LINE = path.join(APP, "scripts", "typography.ts");
const FIXTURES = path.join(APP, "test/fixtures");
const LATO = path.join(FIXTURES, "fonts/Lato-Regular.ttf");
const DEVANAGARI_RUN = path.join(
  FIXTURES,
  "generation/2026-11-10-devanagari-subset"
);

const SOURCE_FONT_ARTIFACT = /^source-font-[0-9a-f]{64}$/;
const MODEL_OUTPUT_ARTIFACT = /^model-output-[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DRAWN = /<path /g;

/** An export as the command line prints it: where the file is, never its bytes. */
interface PrintedExport {
  readonly fonts: readonly (Omit<ExportedFont, "bytes"> & {
    readonly path?: string;
  })[];
  readonly problems: readonly string[];
}

/** The environment without a provider key, so no call here can reach a model. */
const withoutKey = () => {
  const { FAL_API_KEY: _key, ...environment } = process.env;
  return environment;
};

const call = (...args: readonly string[]) => {
  const { status, stderr, stdout } = spawnSync("bun", [COMMAND_LINE, ...args], {
    cwd: APP,
    encoding: "utf8",
    env: withoutKey(),
  });
  return { status, stderr, stdout };
};

/** The one JSON document a call that succeeds prints. */
const answer = <Result>(...args: readonly string[]): Result => {
  const { status, stderr, stdout } = call(...args);
  if (status !== 0) {
    throw new Error(`The command failed (${status}): ${stderr}`);
  }
  return JSON.parse(stdout) as Result;
};

describe("the command line", () => {
  const project = mkdtempSync(path.join(tmpdir(), "typography-cli-"));
  const out = path.join(project, "out");
  let runId = "";
  let exported = "";

  afterAll(() => {
    rmSync(project, { force: true, recursive: true });
  });

  it("imports a font and prints its artifact and faces", () => {
    const imported = answer<Imported>("import", "--project", project, LATO);
    expect(imported.refused).toEqual([]);
    expect(imported.photographs).toEqual([]);
    expect(imported.fonts).toEqual([
      {
        alreadyImported: false,
        artifactId: expect.stringMatching(SOURCE_FONT_ARTIFACT),
        faces: [{ faceId: expect.any(String), label: "Lato Regular" }],
        fileName: "Lato-Regular.ttf",
      },
    ]);
    expect(existsSync(path.join(project, "records.json"))).toBe(true);
  });

  it("inspects the project a second process finds in the directory", () => {
    const inspection = answer<Inspection>("inspect", "--project", project);
    expect(inspection).toMatchObject({
      exports: [],
      photographs: [],
      revisions: 0,
      waiting: { candidates: [], runs: [] },
    });
    const [face] = inspection.faces;
    expect(inspection.faces).toHaveLength(1);
    expect(face).toMatchObject({ editable: true, label: "Lato Regular" });
    expect(
      face?.coverage.find((entry) => entry.script === "Deva")
    ).toMatchObject({ covered: 0, name: "Devanagari" });
  });

  it("generates a script extension from a recorded run, named by the face's label", () => {
    const run = answer<ExtensionRun>(
      "generate",
      "--project",
      project,
      "--face",
      "Lato Regular",
      "--script-extension",
      "devanagari-subset",
      "--recorded",
      DEVANAGARI_RUN
    );
    ({ runId } = run);
    expect(run.glyphs).toHaveLength(18);
    expect(run.unmade).toEqual([]);
    expect(run.source).toEqual({
      model: "ideogram/vector/text-to-vector",
      recorded: true,
      strategy: "vector-model",
    });
    expect(run.modelOutput).toMatch(MODEL_OUTPUT_ARTIFACT);
    const { waiting } = answer<Inspection>("inspect", "--project", project);
    expect(waiting.runs).toEqual([
      expect.objectContaining({ glyphs: 18, runId }),
    ]);
  });

  it("accepts the waiting run as one revision", () => {
    expect(
      answer<Accepted>("accept", "--project", project, "--run", runId)
    ).toEqual({ accepted: 18, revisions: 1 });
  });

  it("exports the font to a directory and prints where, never its bytes", () => {
    const result = answer<PrintedExport>(
      "export",
      "--project",
      project,
      "--face",
      "Lato Regular",
      "--family",
      "Atlas Sans",
      "--out",
      out
    );
    expect(result.problems).toEqual([]);
    const [font] = result.fonts;
    expect(font).toMatchObject({
      digest: expect.stringMatching(DIGEST),
      fileName: "AtlasSans-Regular.ttf",
      kind: "derived",
      path: path.join(out, "AtlasSans-Regular.ttf"),
      ref: { artifactId: expect.any(String), contentId: expect.any(String) },
    });
    expect(font).not.toHaveProperty("bytes");
    expect(
      font?.checks.map((check) => `${check.id}: ${check.outcome}`)
    ).toEqual([
      "engine: pass",
      "reopen: pass",
      "coverage: pass",
      "shaping: pass",
      "joining: pass",
      "browser: not-run",
    ]);
    exported = font?.ref.artifactId ?? "";
    const derived = harfBuzzReader.open(
      new Uint8Array(readFileSync(path.join(out, "AtlasSans-Regular.ttf")))
    );
    expect(derived.description.familyName).toBe("Atlas Sans");
    expect(derived.shape("नमस्ते", { script: "Deva" }).glyphs).toHaveLength(5);
    derived.close();
  });

  it("renders text in the exported font to an SVG file", () => {
    const file = path.join(out, "line.svg");
    const picture = answer<Readonly<Record<string, unknown>>>(
      "render",
      "--project",
      project,
      "--font",
      exported,
      "--text",
      "Hamburg नमस्ते 日",
      "--out",
      file
    );
    expect(picture).toEqual({
      height: expect.any(Number),
      missing: ["日"],
      path: file,
      width: expect.any(Number),
    });
    const svg = readFileSync(file, "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
    // Seven Latin glyphs, five for the Devanagari word, and one crossed box.
    expect(svg.match(DRAWN)).toHaveLength(13);
  });

  it("exits with 1 and one plain sentence when a command refuses", () => {
    const refused = call(
      "accept",
      "--project",
      project,
      "--run",
      "no-such-run"
    );
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe(
      "No run no-such-run is waiting. This project has no waiting run.\n"
    );
  });

  it("refuses a model strategy without a key, and calls nothing", () => {
    const refused = call(
      "generate",
      "--project",
      project,
      "--face",
      "Lato Regular",
      "--characters",
      "é",
      "--strategy",
      "vector-model"
    );
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe(
      "No fal API key was supplied, so this model cannot be called. Add a key to use it.\n"
    );
  });

  it("exits with 1 for an export that is blocked, and for a call it cannot read", () => {
    const blocked = call(
      "export",
      "--project",
      project,
      "--face",
      "Lato Regular",
      "--family",
      "Lato Subset"
    );
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('reserves the name "Lato"');
    const unknown = call("inspect", "--project", project, "--loudly");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("--loudly");
    const nothing = call("polish", "--project", project);
    expect(nothing.status).toBe(1);
    expect(nothing.stderr).toContain("Usage: bun scripts/typography.ts");
  });
});
