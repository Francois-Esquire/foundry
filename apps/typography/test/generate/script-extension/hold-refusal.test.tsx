// @vitest-environment happy-dom
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createArtifactStore } from "~/application/artifact-store";
import { ExtensionRunPanel } from "~/generate/script-extension/extension-run-panel";
import { faceStateOf } from "~/generate/script-extension/session";
import { findFace } from "~/typeface/project";
import { latoExtensionSession } from "./helpers/extension-session";

const noop = () => undefined;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("tells a refused hold apart from a failure while making", async () => {
  const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
  const { session, workspace, faceId } = await latoExtensionSession({
    keepModelOutput: createArtifactStore(artifacts).keepModelOutput,
  });
  vi.spyOn(workspace, "holdRun").mockReturnValue({
    notice: {
      id: "refused",
      message: "The project refused this run.",
      tone: "error",
    },
    ok: false,
  });
  await session.listSource();
  await session.run(faceId);
  const { project } = workspace.getState();
  expect(project.runs).toHaveLength(0);
  expect(project.head).toBe(0);
  const kept = (
    await artifacts.list({
      type: "application/vnd.foundry.typography.model-output",
    })
  ).items;
  expect(kept).toHaveLength(1);
  expect(kept[0]?.content?.state).toBe("frozen");
  const { run } = faceStateOf(session.getState(), faceId);
  expect(run).toMatchObject({ phase: "holding", status: "failed" });
  if (run.status !== "failed") {
    throw new Error("The run did not fail.");
  }
  expect(run.steps.every((step) => step.status === "finished")).toBe(false);
  const page = render(
    <ExtensionRunPanel
      face={findFace(project, faceId)}
      onListAgain={noop}
      onRun={noop}
      run={run}
      source={session.getState().source}
      standing={{ held: 0, kind: "lacking" }}
    />
  );
  expect(page.container.textContent).toContain(
    "The glyphs were made, but the project did not take the run. Nothing entered the face. The run's model output may have been kept."
  );
  expect(page.container.textContent).not.toContain("Nothing was made");
  expect(page.container.textContent).toContain(
    "This extension calls no model and needs no key."
  );
});
