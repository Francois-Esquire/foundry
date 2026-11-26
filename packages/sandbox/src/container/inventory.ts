import { SandboxError } from "../errors";
import { assertNotAborted } from "../sandbox-adapter";
import type { ContainerStore } from "../store/index";
import type { ContainerRow } from "../store/schema";
import type { ContainerSweep, CreateContainersOptions } from "./contracts";
import {
  ACTIVE_CONTAINER_RESOURCE_STATUSES,
  CONTAINER_ID_LABEL,
  CONTAINER_STORE_LABEL,
  INVENTORY_PAGE_LIMIT,
  MAX_INVENTORY_PAGES,
  removeByHand,
} from "./defaults";
import type { AttachedContainer } from "./facets";
import type { ContainerResourceSummary, ContainerRuntime } from "./runtime";

interface Machine {
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
}

interface Attached {
  readonly labels: Readonly<Record<string, string>>;
  readonly nativeId: string;
  readonly vm: AttachedContainer;
}

interface Clearance {
  readonly conflicts: readonly string[];
  readonly stuck: readonly ContainerResourceSummary[];
  readonly unjudged: boolean;
}

type RecordedByAnother = (name: string, except?: string) => Promise<boolean>;

export function createInventory(options: {
  readonly report: CreateContainersOptions["report"];
  readonly runtime: ContainerRuntime;
  readonly selection: Readonly<Record<string, string>>;
  readonly store: ContainerStore;
}) {
  const { runtime, selection, store } = options;
  const abandoned = new Map<string, string>();

  const retryByName = (name: string, rowId: string): void => {
    if (ownsNativeName(rowId, name)) {
      abandoned.set(name, rowId);
    }
  };

  const report = (line: string): void => {
    try {
      (
        options.report ??
        ((text: string) => process.stderr.write(`foundry: ${text}\n`))
      )(line);
    } catch {
      // biome-ignore lint/complexity/noUselessReturn: End the best-effort operation on failure.
      return;
    }
  };

  const abandon = (machine: Machine, rowId: string, own: string): void => {
    if (isRowsMachine(machine, rowId, own)) {
      abandoned.set(machine.name, rowId);
    } else {
      report(
        `container ${rowId}: the VM ${machine.name} would not go, and is not provably this instance's, so it is not kept to retry; remove it by hand with ${removeByHand(machine.name)}`
      );
    }
  };

  const discardBooted = async (
    machine: Machine,
    rowId: string,
    own: string,
    vm: AttachedContainer
  ): Promise<void> => {
    if (!isRowsMachine(machine, rowId, own)) {
      report(
        `container ${rowId}: the VM ${machine.name} it booted is not provably its own, so it is left; remove it by hand with ${removeByHand(machine.name)}`
      );
      return;
    }
    try {
      await vm.remove();
    } catch {
      abandon(machine, rowId, own);
    }
  };

  const removeSuperseded = async (
    name: string,
    rowId: string
  ): Promise<void> => {
    let resource: ContainerResourceSummary | undefined;
    let own: string;
    try {
      own = await store.identity();
      resource = (await enumerate(runtime, selection, undefined)).find(
        (each) => each.name === name
      );
    } catch (error: unknown) {
      retryByName(name, rowId);
      report(
        `container ${rowId}: its old VM ${name} could not be judged (${String(error)}); kept to retry once the inventory can be read`
      );
      return;
    }
    if (resource === undefined) {
      return;
    }
    if (!isRowsMachine(resource, rowId, own)) {
      report(
        `container ${rowId}: its old VM ${name} is not provably this instance's, so it is left; remove it by hand with ${removeByHand(name)}`
      );
      return;
    }
    try {
      await dispose(runtime, resource);
    } catch {
      abandon(resource, rowId, own);
    }
  };

  const reclaim = async (
    signal: AbortSignal | undefined,
    own: string
  ): Promise<{
    readonly passedOver: string[];
    readonly removed: string[];
    readonly resources: readonly ContainerResourceSummary[];
  }> => {
    const candidates = [...abandoned];
    const recordedByAnother = recordedNames();
    const passedOver: string[] = [];
    const resources = await enumerate(runtime, selection, signal);
    const listed = new Map(
      resources.map((resource) => [resource.name, resource])
    );
    const removed: string[] = [];
    let failure: { readonly error: unknown } | undefined;
    for (const [name, rowId] of candidates) {
      if (abandoned.get(name) !== rowId) {
        continue;
      }
      const resource = listed.get(name);
      try {
        if (resource !== undefined) {
          if (
            isRowsMachine(resource, rowId, own) &&
            !(await recordedByAnother(name, rowId))
          ) {
            await dispose(runtime, resource);
            removed.push(name);
          } else {
            passedOver.push(name);
          }
        }
        abandoned.delete(name);
      } catch (error: unknown) {
        failure ??= { error };
      }
    }
    if (failure !== undefined) {
      throw new SandboxError(
        "provider-failed",
        `could not remove ${candidates
          .filter(([name]) => abandoned.has(name))
          .map(([name]) => name)
          .join(", ")}`,
        { cause: failure.error }
      );
    }
    return { passedOver, removed, resources };
  };

  const removeAttached = async (
    rowId: string,
    attached: Attached,
    action: "close" | "restart"
  ): Promise<void> => {
    const machine = { labels: attached.labels, name: attached.nativeId };
    const own = await store.identity();
    if (!isRowsMachine(machine, rowId, own)) {
      report(
        `container ${rowId}: its VM ${machine.name} is not provably its own, so its ${action} left it; remove it by hand with ${removeByHand(machine.name)}`
      );
      return;
    }
    try {
      await attached.vm.remove();
    } catch (error: unknown) {
      abandon(machine, rowId, own);
      throw error;
    }
  };

  const clearRow = async (row: ContainerRow): Promise<Clearance> => {
    const conflicts: string[] = [];
    const stuck: ContainerResourceSummary[] = [];
    let resources: readonly ContainerResourceSummary[];
    try {
      resources = await enumerate(runtime, selection, undefined);
    } catch {
      return { conflicts, stuck, unjudged: true };
    }
    const recordedByAnother = recordedNames();
    for (const resource of resources) {
      if (
        resource.labels[CONTAINER_ID_LABEL] !== row.id &&
        resource.name !== row.nativeId &&
        !ownsNativeName(row.id, resource.name)
      ) {
        continue;
      }
      const others = await anotherOwns(row, resource, recordedByAnother);
      if (others === undefined) {
        return { conflicts, stuck, unjudged: true };
      }
      if (others) {
        conflicts.push(resource.name);
      } else if (await disposeListed(resource)) {
        abandoned.delete(resource.name);
      } else {
        stuck.push(resource);
      }
    }
    return { conflicts, stuck, unjudged: false };
  };

  const anotherOwns = async (
    row: ContainerRow,
    machine: Machine,
    recordedByAnother: RecordedByAnother
  ): Promise<boolean | undefined> => {
    try {
      return (
        !isRowsMachine(machine, row.id, await store.identity()) ||
        (await recordedByAnother(machine.name, row.id))
      );
    } catch {
      return undefined;
    }
  };

  const recordedNames = (): RecordedByAnother => {
    let rows: Promise<readonly ContainerRow[]> | undefined;
    return async (name, except) => {
      rows ??= store.list();
      return (await rows).some(
        (stored) => stored.id !== except && stored.nativeId === name
      );
    };
  };

  const disposeListed = async (
    resource: ContainerResourceSummary
  ): Promise<boolean> => {
    try {
      await dispose(runtime, resource);
      return true;
    } catch {
      try {
        const listed = await enumerate(runtime, selection, undefined);
        return !listed.some((each) => each.name === resource.name);
      } catch {
        return false;
      }
    }
  };

  const retryStuck = async (
    stuck: readonly ContainerResourceSummary[],
    rowId: string
  ): Promise<void> => {
    const own = await store.identity();
    for (const resource of stuck) {
      abandon(resource, rowId, own);
    }
  };

  const retryAtShutdown = async (): Promise<void> => {
    if (abandoned.size === 0) {
      return;
    }
    const { passedOver } = await reclaim(undefined, await store.identity());
    for (const name of passedOver) {
      report(
        `the VM ${name} this instance kept to retry is not provably its own now, so its shutdown left it; remove it by hand with ${removeByHand(name)}`
      );
    }
  };

  const sweep = async (signal?: AbortSignal): Promise<ContainerSweep> => {
    const own = await store.identity();
    const {
      passedOver,
      removed: swept,
      resources,
    } = await reclaim(signal, own);
    const recordedByAnother = recordedNames();
    for (const resource of resources) {
      assertNotAborted(signal, "container sweep was cancelled");
      if (swept.includes(resource.name) || passedOver.includes(resource.name)) {
        continue;
      }
      const id = resource.labels[CONTAINER_ID_LABEL];
      if (id === undefined || !isRowsMachine(resource, id, own)) {
        passedOver.push(resource.name);
        continue;
      }
      if (
        (await store.get(id)) !== undefined ||
        (await recordedByAnother(resource.name))
      ) {
        continue;
      }
      await dispose(runtime, resource);
      swept.push(resource.name);
    }
    return sweepResult(swept, passedOver);
  };

  return {
    clearRow,
    discardBooted,
    removeAttached,
    removeSuperseded,
    retryAtShutdown,
    retryByName,
    retryStuck,
    sweep,
  };
}

export function ownsNativeName(rowId: string, name: string): boolean {
  return (
    name.startsWith(`${rowId}-`) &&
    GENERATION.test(name.slice(rowId.length + 1))
  );
}

const GENERATION = /^\d+$/;

function sweepResult(
  swept: readonly string[],
  passedOver: readonly string[]
): ContainerSweep {
  const result = [...swept];
  Object.defineProperty(result, "passedOver", {
    enumerable: false,
    value: Object.freeze([...passedOver]),
  });
  return Object.freeze(result) as unknown as ContainerSweep;
}

function isRowsMachine(
  machine: Machine,
  rowId: string,
  store: string
): boolean {
  return (
    machine.labels[CONTAINER_STORE_LABEL] === store &&
    ownsNativeName(rowId, machine.name) &&
    machine.labels[CONTAINER_ID_LABEL] === rowId
  );
}

async function dispose(
  runtime: ContainerRuntime,
  resource: ContainerResourceSummary
): Promise<void> {
  if (ACTIVE_CONTAINER_RESOURCE_STATUSES.has(resource.status)) {
    await runtime.stopResource(resource.name);
  }
  await runtime.removeResource(resource.name);
}

async function enumerate(
  runtime: ContainerRuntime,
  labels: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined
): Promise<readonly ContainerResourceSummary[]> {
  const resources: ContainerResourceSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
    assertNotAborted(signal, "container sweep was cancelled");
    const result = await runtime.listResources({
      labels,
      limit: INVENTORY_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    resources.push(...result.resources);
    if (result.nextCursor === undefined) {
      return resources;
    }
    cursor = result.nextCursor;
  }
  throw new SandboxError(
    "provider-failed",
    "container inventory did not terminate"
  );
}
