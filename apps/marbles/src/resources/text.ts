import type { ResourceView, Shown } from "~/database/resources";
import type { ResourceKind } from "~/lib/resources";
import type { RunStep } from "~/lib/run-trace";
import { runSteps } from "~/lib/run-trace";

export function resourceLines(
  kind: ResourceKind,
  view: ResourceView,
  here: string
): Promise<string[]> {
  return LINES[kind](view, here);
}

const LINES: {
  readonly [K in ResourceKind]: (
    view: ResourceView,
    here: string
  ) => Promise<string[]>;
} = {
  async artifact(view, here) {
    return (await view.artifacts()).map(
      (shown) =>
        `${shown.ref.id}  ${shown.value.name}  ${shown.value.type}  [${shown.value.status}]  ${shown.value.updatedAt.toISOString()}${belonging(shown, here)}`
    );
  },
  async module(view, here) {
    return (await view.modules()).map(
      (shown) =>
        `${shown.ref.id}  artifact ${shown.value.artifactId}${belonging(shown, here)}`
    );
  },
  async run(view, here) {
    return (await view.runs()).flatMap((shown) => {
      const { record } = shown.value;
      return [
        `${record.id}  ${record.step}  [${record.status}]  ${new Date(record.timestamps.createdAt).toISOString()}${belonging(shown, here)}`,
        ...stepLines(runSteps(record), "  "),
      ];
    });
  },
  async sandbox(view, here) {
    return (await view.sandboxes()).map(
      (shown) =>
        `${shown.ref.id}  [${shown.value.status}]  ${new Date(shown.value.createdAt).toISOString()}${belonging(shown, here)}`
    );
  },
  async session(view, here) {
    const sessions = await view.sessions();
    const tallies = await view.messageTallies(sessions.map(({ ref }) => ref));
    return sessions.map((shown) => {
      const tally = tallies.get(shown.ref);
      return `${shown.ref.id}  ${String(tally?.messages ?? 0)} messages  ${new Date(shown.value.updatedAt).toISOString()}  summary: ${tally?.summarized ? "yes" : "no"}${belonging(shown, here)}`;
    });
  },
};

function stepLines(steps: readonly RunStep[], indent: string): string[] {
  return steps.flatMap((step) => [
    `${indent}${step.name}  [${step.status}]`,
    ...stepLines(step.children, `${indent}  `),
  ]);
}

function belonging(shown: Shown<unknown>, here: string): string {
  const [owner, ...shared] = shown.workspaces;
  const from = owner === here ? "" : `  from ${owner}`;
  const others = shared.filter((workspace) => workspace !== here);
  return `${from}${others.length === 0 ? "" : `  shared with ${others.join(", ")}`}`;
}
