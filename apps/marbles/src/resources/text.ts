import type { ResourceView, Shown } from "~/database/resources";
import type { ResourceKind } from "~/lib/resources";
import type { RunStep } from "~/lib/run-trace";
import { runSteps } from "~/lib/run-trace";

/**
 * The lines `marbles runs`, `sessions`, `artifacts`, `sandboxes` and
 * `modules` print: one per resource the view shows, newest first, a run's
 * steps under it as its detail. A resource another workspace owns ends with
 * the workspace it is from; one shared with other workspaces names them.
 */

/** The lines listing every resource of `kind` that `view` shows, seen from the workspace `here`. */
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
    const lines: string[] = [];
    for (const shown of await view.sessions()) {
      const messages = await view.messages(shown.ref);
      const summary = messages.some((message) => message.role === "summary");
      lines.push(
        `${shown.ref.id}  ${String(messages.length)} messages  ${new Date(shown.value.updatedAt).toISOString()}  summary: ${summary ? "yes" : "no"}${belonging(shown, here)}`
      );
    }
    return lines;
  },
};

function stepLines(steps: readonly RunStep[], indent: string): string[] {
  return steps.flatMap((step) => [
    `${indent}${step.name}  [${step.status}]`,
    ...stepLines(step.children, `${indent}  `),
  ]);
}

/** Where a resource is from, when not `here`, and who else it is shared with. */
function belonging(shown: Shown<unknown>, here: string): string {
  const [owner, ...shared] = shown.workspaces;
  const from = owner === here ? "" : `  from ${owner}`;
  const others = shared.filter((workspace) => workspace !== here);
  return `${from}${others.length === 0 ? "" : `  shared with ${others.join(", ")}`}`;
}
