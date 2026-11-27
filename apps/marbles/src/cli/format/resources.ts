import type { ResourceView, Shown } from "~/database/resources";
import type { ResourceKind } from "~/lib/resources";
import type { RunStep } from "~/lib/run-trace";
import { runSteps } from "~/lib/run-trace";
import type {
  ArtifactResourceItem,
  ResourceItem,
  RunResourceItem,
  SandboxResourceItem,
  SessionResourceItem,
} from "~/service/ports";

export async function resourceLines(
  kind: ResourceKind,
  view: ResourceView,
  here: string
): Promise<string[]> {
  return resourceItemLines(kind, await viewItems(kind, view), here);
}

export function resourceItemLines(
  kind: ResourceKind,
  items: readonly ResourceItem[],
  here: string
): string[] {
  switch (kind) {
    case "artifact":
      return (items as readonly ArtifactResourceItem[]).map(
        (item) =>
          `${item.id}  ${item.name}  ${item.type}  [${item.status}]  ${item.updatedAt}${belongingItem(item, here)}`
      );
    case "run":
      return (items as readonly RunResourceItem[]).flatMap((item) => [
        `${item.id}  ${item.step}  [${item.status}]  ${item.createdAt}${belongingItem(item, here)}`,
        ...stepLines(item.steps, "  "),
      ]);
    case "sandbox":
      return (items as readonly SandboxResourceItem[]).map(
        (item) =>
          `${item.id}  [${item.status}]  ${item.createdAt}${belongingItem(item, here)}`
      );
    case "session":
      return (items as readonly SessionResourceItem[]).map(
        (item) =>
          `${item.id}  ${String(item.messages)} messages  ${item.updatedAt}  summary: ${item.summarized ? "yes" : "no"}${belongingItem(item, here)}`
      );
    default:
      return kind satisfies never;
  }
}

export function resourceDetailLines(
  kind: ResourceKind,
  item: ResourceItem
): string[] {
  const base = [`id: ${item.id}`, `workspace: ${item.owner}`];
  switch (kind) {
    case "artifact": {
      const artifact = item as ArtifactResourceItem;
      return [
        ...base,
        `name: ${artifact.name}`,
        `type: ${artifact.type}`,
        `status: ${artifact.status}`,
        `updated: ${artifact.updatedAt}`,
      ];
    }
    case "run": {
      const run = item as RunResourceItem;
      return [
        ...base,
        `step: ${run.step}`,
        `status: ${run.status}`,
        `created: ${run.createdAt}`,
        ...(run.steps.length === 0
          ? []
          : ["steps:", ...stepLines(run.steps, "  ")]),
      ];
    }
    case "sandbox": {
      const sandbox = item as SandboxResourceItem;
      return [
        ...base,
        `status: ${sandbox.status}`,
        `created: ${sandbox.createdAt}`,
      ];
    }
    case "session": {
      const session = item as SessionResourceItem;
      return [
        ...base,
        `messages: ${String(session.messages)}`,
        `summary: ${session.summarized ? "yes" : "no"}`,
        `updated: ${session.updatedAt}`,
      ];
    }
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

async function viewItems(
  kind: ResourceKind,
  view: ResourceView
): Promise<readonly ResourceItem[]> {
  switch (kind) {
    case "artifact":
      return (await view.artifacts()).map((shown) => ({
        id: shown.ref.id,
        name: shown.value.name,
        ...ownership(shown),
        status: shown.value.status,
        type: shown.value.type,
        updatedAt: shown.value.updatedAt.toISOString(),
      }));
    case "run":
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
    case "sandbox":
      return (await view.sandboxes()).map((shown) => ({
        createdAt: new Date(shown.value.createdAt).toISOString(),
        id: shown.ref.id,
        ...ownership(shown),
        status: shown.value.status,
      }));
    case "session": {
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
    }
    default:
      return kind satisfies never;
  }
}

function stepLines(steps: readonly RunStep[], indent: string): string[] {
  return steps.flatMap((step) => [
    `${indent}${step.name}  [${step.status}]`,
    ...stepLines(step.children, `${indent}  `),
  ]);
}

function belongingItem(
  item: Pick<ResourceItem, "owner" | "sharedWith">,
  here: string
): string {
  const from = item.owner === here ? "" : `  from ${item.owner}`;
  const others = item.sharedWith.filter((workspace) => workspace !== here);
  return `${from}${others.length === 0 ? "" : `  shared with ${others.join(", ")}`}`;
}
