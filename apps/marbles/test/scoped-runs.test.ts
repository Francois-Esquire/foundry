import { describe, expect, it } from "vitest";
import type { AnyDefinition } from "~/lib/definition";
import { DEFINITION_IDENTITY } from "~/lib/handles";
import type { RunsSource } from "~/lib/managers/runs";
import { scopedRuns } from "~/lib/managers/runs";
import { RunScope } from "~/lib/run-scope";

function raw(value: string, identity?: string): AnyDefinition {
  const definition: AnyDefinition = { fn: () => value, kind: "step" };
  if (identity !== undefined) {
    Object.defineProperty(definition, DEFINITION_IDENTITY, {
      value: identity,
    });
  }
  return definition;
}

function recording() {
  const launched: AnyDefinition[] = [];
  const source = {
    launch: (definition: AnyDefinition) => {
      launched.push(definition);
      return Promise.resolve({
        id: `rn-${String(launched.length)}`,
        result: Promise.resolve(undefined),
      });
    },
    resultOf: () => Promise.resolve(undefined),
  } as unknown as RunsSource;
  const scope = new RunScope("rn-parent", process.cwd());
  const frame = scope.frame(["parent"]);
  const runs = scopedRuns(source, { frame, scope, write: () => undefined });
  return { frame, launched, runs, scope };
}

describe("a launch from a run body", () => {
  it("reuses the run recorded at its place for a definition the authoring words did not build", async () => {
    const { frame, launched, runs, scope } = recording();
    const first = await runs.launch(raw("first"), {});
    await scope.enter(frame);
    const again = await runs.launch(raw("second"), {});
    expect(again.id).toBe(first.id);
    expect(launched).toHaveLength(1);
  });

  it("launches anew when the definition built at its place differs, and reuses the same one", async () => {
    const { frame, launched, runs, scope } = recording();
    const first = await runs.launch(raw("first", "catalog:a#1"), {});
    await scope.enter(frame);
    const switched = await runs.launch(raw("second", "catalog:a#2"), {});
    await scope.enter(frame);
    const same = await runs.launch(raw("second", "catalog:a#2"), {});
    expect(switched.id).not.toBe(first.id);
    expect(same.id).toBe(switched.id);
    expect(launched).toHaveLength(2);
  });
});
