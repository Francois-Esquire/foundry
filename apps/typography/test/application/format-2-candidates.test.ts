import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeApplication } from "~/application/node";
import {
  candidateStatuses,
  checkout,
  redo,
  type TypefaceProject,
  undo,
} from "~/typeface/project";
import { AT, FIXTURES } from "./helpers/project";

const fixture = path.join(FIXTURES, "projects/format-2");
const original = JSON.parse(
  readFileSync(path.join(fixture, "project.json"), "utf8")
);
const inspection = JSON.parse(
  readFileSync(path.join(fixture, "inspect.json"), "utf8")
);
const copies: string[] = [];
afterEach(() => {
  for (const directory of copies.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});
const copy = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "typography-format-2-"));
  copies.push(directory);
  cpSync(path.join(fixture, "directory"), directory, { recursive: true });
  const artifacts = new ArtifactManager({
    files: blobFiles(path.join(directory, "blobs")),
    store: new JsonArtifactStore({
      path: path.join(directory, "records.json"),
    }),
  });
  return {
    artifacts,
    open: () =>
      openNodeApplication({
        clock: () => new Date(AT),
        directory,
        newId: () => "unused",
      }),
  };
};
const storedProject = async (artifacts: ArtifactManager) => {
  const [artifact] = (
    await artifacts.list({ type: "application/vnd.foundry.typography.project" })
  ).items;
  if (!artifact?.content) {
    throw new Error("Missing project");
  }
  const file = await artifacts.readFile(artifact.content.id, "project.json");
  if (!file) {
    throw new Error("Missing project file");
  }
  return { artifact, parsed: JSON.parse(new TextDecoder().decode(file.blob)) };
};
const statuses = (project: TypefaceProject) => [
  ...candidateStatuses(project).values(),
];

describe("C5: format 2 candidate standing", () => {
  it("opens with every record and the inspection its writer gave", async () => {
    const { artifacts, open } = copy();
    expect((await storedProject(artifacts)).parsed).toEqual(original);
    const app = await open();
    const { project } = app.workspace.getState();
    expect(app.inspect()).toEqual(inspection);
    expect(
      project.candidates.map((candidate) => ({
        ...candidate,
        status: candidateStatuses(project).get(candidate.id),
      }))
    ).toEqual(original.candidates);
    expect(statuses(project)).toEqual(
      original.candidates.map(
        (candidate: { status: string }) => candidate.status
      )
    );
    expect(project.revisions).toEqual(original.revisions);
    expect(project.runs).toEqual(original.runs);
    expect(project.photographs).toEqual(
      original.photographs.map(
        ({ artifactId: _artifactId, ...photograph }: { artifactId: string }) =>
          photograph
      )
    );
    expect(project.head).toBe(original.head);
    const accepted = original.candidates.findIndex(
      (candidate: { status: string }) => candidate.status === "accepted"
    );
    expect(statuses(undo(project))[accepted]).toBe("proposed");
    expect(statuses(redo(undo(project)))).toEqual(statuses(project));
    expect(checkout(project, 0).head).toBe(0);
    expect(checkout(checkout(project, 0), project.head).revisions).toEqual(
      project.revisions
    );
    await app.close();
  });
  it("saves an untouched project with parsed JSON equal to the original", async () => {
    const { artifacts, open } = copy();
    const app = await open();
    await app.save();
    await app.close();
    expect((await storedProject(artifacts)).parsed).toEqual(original);
  });
  it.each([
    ["accepted", "proposed"],
    ["accepted", "rejected"],
    ["proposed", "accepted"],
  ])(
    "opens a %s candidate stored as %s by the history without dropping work",
    async (standing, stored) => {
      const { artifacts, open } = copy();
      const { artifact, parsed } = await storedProject(artifacts);
      const index = parsed.candidates.findIndex(
        (candidate: { status: string }) => candidate.status === standing
      );
      parsed.candidates[index].status = stored;
      await artifacts.write({
        artifactId: artifact.id,
        changes: {
          put: {
            "project.json": {
              bytes: JSON.stringify(parsed),
              mime: "application/json",
            },
          },
        },
      });
      const app = await open();
      const { project } = app.workspace.getState();
      expect(statuses(project)[index]).toBe(standing);
      expect(
        project.candidates.map(
          ({ rejected: _rejected, ...candidate }) => candidate
        )
      ).toEqual(
        original.candidates.map(
          ({ status: _status, ...candidate }: { status: string }) => candidate
        )
      );
      expect(project.candidates).toHaveLength(original.candidates.length);
      expect(project.revisions).toEqual(original.revisions);
      expect(project.runs).toEqual(original.runs);
      expect(project.photographs).toHaveLength(original.photographs.length);
      expect(app.inspect()).toEqual(inspection);
      expect((await storedProject(artifacts)).parsed).toEqual(parsed);
      await app.close();
    }
  );
});
