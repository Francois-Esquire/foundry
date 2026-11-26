import type { ResourceView, Shown } from "~/database/resources";
import type { ResourceKind } from "~/lib/resources";
import type { RunStep } from "~/lib/run-trace";
import { runSteps } from "~/lib/run-trace";

export interface ResourceItem {
  readonly id: string;
  readonly owner: string;
  readonly sharedWith: readonly string[];
  readonly [key: string]: unknown;
}

export function resourceLines(
  kind: ResourceKind,
  view: ResourceView,
  here: string
): Promise<string[]> {
  return LINES[kind](view, here);
}

export function resourceItems(
  kind: ResourceKind,
  view: ResourceView
): Promise<ResourceItem[]> {
  return ITEMS[kind](view);
}

export async function resourceDetail(
  kind: ResourceKind,
  id: string,
  view: ResourceView
): Promise<
  { readonly item: ResourceItem; readonly lines: readonly string[] } | undefined
> {
  const items = await ITEMS[kind](view);
  const found = items.find((entry) => entry.id === id);
  if (found === undefined) {
    return undefined;
  }
  return { item: found, lines: detailLines(kind, found) };
}

function detailLines(kind: ResourceKind, item: ResourceItem): string[] {
  const base = [`id: ${item.id}`, `workspace: ${item.owner}`];
  switch (kind) {
    case "artifact":
      return [
        ...base,
        `name: ${String(item.name)}`,
        `type: ${String(item.type)}`,
        `status: ${String(item.status)}`,
        `updated: ${String(item.updatedAt)}`,
      ];
    case "run": {
      const steps = Array.isArray(item.steps)
        ? (item.steps as readonly RunStep[])
        : [];
      return [
        ...base,
        `step: ${String(item.step)}`,
        `status: ${String(item.status)}`,
        `created: ${String(item.createdAt)}`,
        ...(steps.length === 0 ? [] : ["steps:", ...stepLines(steps, "  ")]),
      ];
    }
    case "sandbox":
      return [
        ...base,
        `status: ${String(item.status)}`,
        `created: ${String(item.createdAt)}`,
      ];
    case "session":
      return [
        ...base,
        `messages: ${String(item.messages)}`,
        `summary: ${item.summarized ? "yes" : "no"}`,
        `updated: ${String(item.updatedAt)}`,
      ];
    default:
      return kind satisfies never;
  }
}

function ownership(shown: Shown<unknown>): {
  readonly owner: string;
  readonly sharedWith: readonly string[];
} {
  const [owner = "", ...sharedWith] = shown.workspaces;
  return { owner, sharedWith };
}

const ITEMS: {
  readonly [K in ResourceKind]: (view: ResourceView) => Promise<ResourceItem[]>;
} = {
  async artifact(view) {
    return (await view.artifacts()).map((shown) => ({
      id: shown.ref.id,
      name: shown.value.name,
      ...ownership(shown),
      status: shown.value.status,
      type: shown.value.type,
      updatedAt: shown.value.updatedAt.toISOString(),
    }));
  },
  async run(view) {
    return (await view.runs()).map((shown) => {
      const { record } = shown.value;
      return {
        createdAt: new Date(record.timestamps.createdAt).toISOString(),
        id: record.id,
        ...ownership(shown),
        status: record.status,
        step: record.step,
        steps: runSteps(record),
      };
    });
  },
  async sandbox(view) {
    return (await view.sandboxes()).map((shown) => ({
      createdAt: new Date(shown.value.createdAt).toISOString(),
      id: shown.ref.id,
      ...ownership(shown),
      status: shown.value.status,
    }));
  },
  async session(view) {
    const sessions = await view.sessions();
    const tallies = await view.messageTallies(sessions.map(({ ref }) => ref));
    return sessions.map((shown) => {
      const tally = tallies.get(shown.ref);
      return {
        id: shown.ref.id,
        messages: tally?.messages ?? 0,
        ...ownership(shown),
        summarized: Boolean(tally?.summarized),
        updatedAt: new Date(shown.value.updatedAt).toISOString(),
      };
    });
  },
};

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
