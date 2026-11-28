import { expect, expectTypeOf, it } from "vitest";
import type { RunRecord } from "~/lib/runs/records";
import { type ReadonlyRunScopes, RunScope } from "~/lib/runs/scope";
import type { LiveWork } from "~/lib/runs/step-work";
import type { WorkspaceHost } from "~/workspace/index";
import { liveView } from "~/workspace/live-work";

function stored(id: string, status: RunRecord["status"]): RunRecord {
  return { id, status } as RunRecord;
}

function held(...scopes: RunScope[]): ReadonlyRunScopes {
  const byId = new Map(scopes.map((scope) => [scope.id, scope] as const));
  return {
    get: (runId) => byId.get(runId),
    has: (runId) => byId.has(runId),
    size: byId.size,
    [Symbol.iterator]: () => byId.values(),
  };
}

const remote: LiveWork = {
  command: "make",
  id: "remote-work",
  input: "stdin",
  kind: "command",
  stepId: "build",
};

it("keeps this engine's own view of a run it holds, whatever another generation reports for it", () => {
  const scope = new RunScope("run-here", "/workspace");
  scope.frame(["build"]).work.begin({ command: "npm test", kind: "command" });
  const scopes = held(scope);
  const view = liveView([stored("run-here", "running")], scopes, [
    { record: stored("run-here", "complete"), work: [remote] },
  ]);
  expect(view.records).toEqual([stored("run-here", "running")]);
  expect(view.work.get("run-here")).toMatchObject([{ command: "npm test" }]);
});

it("shows the owner's record and work for a run another generation holds, replacing the stored one or adding it", () => {
  const scopes = held();
  const view = liveView(
    [stored("run-listed", "queued"), stored("run-settled", "complete")],
    scopes,
    [
      { record: stored("run-listed", "running"), work: [remote] },
      { record: stored("run-unlisted", "running"), work: [] },
    ]
  );
  expect(view.records).toEqual([
    stored("run-listed", "running"),
    stored("run-settled", "complete"),
    stored("run-unlisted", "running"),
  ]);
  expect(view.work.get("run-listed")).toEqual([remote]);
  expect(view.work.get("run-unlisted")).toEqual([]);
  expect(view.work.has("run-settled")).toBe(false);
});

it("keeps generation aggregation out of the published host contract", () => {
  expectTypeOf<WorkspaceHost["snapshot"]>().parameters.toEqualTypeOf<[]>();
  expectTypeOf<WorkspaceHost>().not.toHaveProperty("live");
});
