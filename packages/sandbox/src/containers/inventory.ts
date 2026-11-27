import { SandboxError } from "../errors";
import { assertNotAborted } from "../sandbox-adapter";
import type { ContainerStore } from "../store/index";
import type { ContainerRow } from "../store/schema";
import type { ContainerSweep, CreateContainersOptions } from "./contracts";
import {
  ACTIVE_CONTAINER_RESOURCE_STATUSES,
  CONTAINER_ID_LABEL,
  CONTAINER_STORE_LABEL,
  defaultRemovalHint,
  INVENTORY_PAGE_LIMIT,
  MAX_INVENTORY_PAGES,
} from "./defaults";
import type { Driver, DriverResourceSummary } from "./driver";
import type { AttachedContainer } from "./facets";

interface ResourceMeta {
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
  readonly stuck: readonly DriverResourceSummary[];
  readonly unjudged: boolean;
}

type RecordedByAnother = (name: string, except?: string) => Promise<boolean>;

export function createInventory(options: {
  readonly driver: Driver;
  readonly report: CreateContainersOptions["report"];
  readonly selection: Readonly<Record<string, string>>;
  readonly store: ContainerStore;
}) {
  const { driver, selection, store } = options;
  const abandoned = new Map<string, string>();
  const hint = (name: string): string =>
    driver.manualRemovalHint?.(name) ?? defaultRemovalHint(name);

  const retryByName = (name: string, rowId: string): void => {
    abandoned.set(name, rowId);
  };

  const report = (line: string): void => {
    try {
      (
        options.report ??
        ((text: string) => {
          console.error(`foundry: ${text}`);
        })
      )(line);
    } catch {
      // biome-ignore lint/complexity/noUselessReturn: End best-effort reporting on failure.
      return;
    }
  };

  const abandon = (
    resource: ResourceMeta,
    rowId: string,
    own: string
  ): void => {
    if (isRowsResource(resource, rowId, own)) {
      abandoned.set(resource.name, rowId);
    } else {
      report(
        `container ${rowId}: resource ${resource.name} could not be removed and is not provably owned by this store; ${hint(resource.name)}`
      );
    }
  };

  const discardBooted = async (
    resource: ResourceMeta,
    rowId: string,
    own: string,
    vm: AttachedContainer
  ): Promise<void> => {
    if (!isRowsResource(resource, rowId, own)) {
      report(
        `container ${rowId}: booted resource ${resource.name} is not provably owned by this store; ${hint(resource.name)}`
      );
      return;
    }
    try {
      await vm.remove();
    } catch {
      abandon(resource, rowId, own);
    }
  };

  const removeSuperseded = async (
    name: string,
    rowId: string
  ): Promise<void> => {
    if (driver.listResources === undefined) {
      try {
        await driver.stopResource(name).catch(() => undefined);
        await driver.removeResource(name);
      } catch {
        retryByName(name, rowId);
      }
      return;
    }
    let resource: DriverResourceSummary | undefined;
    let own: string;
    try {
      own = await store.identity();
      resource = (await enumerate(driver, selection, undefined)).find(
        (each) => each.name === name
      );
    } catch (error: unknown) {
      retryByName(name, rowId);
      report(
        `container ${rowId}: previous resource ${name} could not be checked (${String(error)}); kept to retry`
      );
      return;
    }
    if (resource === undefined) {
      return;
    }
    if (!isRowsResource(resource, rowId, own)) {
      report(
        `container ${rowId}: previous resource ${name} is not provably owned by this store; ${hint(name)}`
      );
      return;
    }
    try {
      await dispose(driver, resource);
    } catch {
      abandon(resource, rowId, own);
    }
  };

  const reclaimDirect = async (
    candidates: readonly [string, string][]
  ): Promise<{
    readonly passedOver: string[];
    readonly removed: string[];
    readonly resources: readonly DriverResourceSummary[];
  }> => {
    const removed: string[] = [];
    let failure: { readonly error: unknown } | undefined;
    for (const [name] of candidates) {
      try {
        await driver.stopResource(name).catch(() => undefined);
        await driver.removeResource(name);
        removed.push(name);
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
    return { passedOver: [], removed, resources: [] };
  };

  const reclaim = async (
    signal: AbortSignal | undefined,
    own: string
  ): Promise<{
    readonly passedOver: string[];
    readonly removed: string[];
    readonly resources: readonly DriverResourceSummary[];
  }> => {
    const candidates = [...abandoned];
    if (driver.listResources === undefined) {
      return reclaimDirect(candidates);
    }
    const recordedByAnother = recordedNames();
    const passedOver: string[] = [];
    const resources = await enumerate(driver, selection, signal);
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
            isRowsResource(resource, rowId, own) &&
            !(await recordedByAnother(name, rowId))
          ) {
            await dispose(driver, resource);
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
    const resource = { labels: attached.labels, name: attached.nativeId };
    const own = await store.identity();
    if (!isRowsResource(resource, rowId, own)) {
      report(
        `container ${rowId}: resource ${resource.name} is not provably owned by this store, so ${action} left it; ${hint(resource.name)}`
      );
      return;
    }
    try {
      await attached.vm.remove();
    } catch (error: unknown) {
      abandon(resource, rowId, own);
      throw error;
    }
  };

  const clearRowDirect = async (row: ContainerRow): Promise<Clearance> => {
    if (row.nativeId === undefined) {
      return { conflicts: [], stuck: [], unjudged: false };
    }
    try {
      const status =
        driver.inspect === undefined
          ? "running"
          : await driver.inspect(row.nativeId);
      if (status === undefined) {
        return { conflicts: [], stuck: [], unjudged: false };
      }
      if (ACTIVE_CONTAINER_RESOURCE_STATUSES.has(status)) {
        await driver.stopResource(row.nativeId);
      }
      await driver.removeResource(row.nativeId);
      abandoned.delete(row.nativeId);
      return { conflicts: [], stuck: [], unjudged: false };
    } catch {
      return {
        conflicts: [],
        stuck: [{ labels: {}, name: row.nativeId, status: "running" }],
        unjudged: false,
      };
    }
  };

  const clearRow = async (row: ContainerRow): Promise<Clearance> => {
    if (driver.listResources === undefined) {
      return clearRowDirect(row);
    }
    const conflicts: string[] = [];
    const stuck: DriverResourceSummary[] = [];
    let resources: readonly DriverResourceSummary[];
    try {
      resources = await enumerate(driver, selection, undefined);
    } catch {
      return { conflicts, stuck, unjudged: true };
    }
    const recordedByAnother = recordedNames();
    for (const resource of resources) {
      if (!matchesRow(row, resource)) {
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
    resource: ResourceMeta,
    recordedByAnother: RecordedByAnother
  ): Promise<boolean | undefined> => {
    try {
      const ownStore = await store.identity();
      const nameValid =
        ownsNativeName(row.id, resource.name) ||
        (resource.name === row.nativeId &&
          !NATIVE_NAME_PATTERN.test(resource.name));
      return (
        !(isRowsResource(resource, row.id, ownStore) && nameValid) ||
        (await recordedByAnother(resource.name, row.id))
      );
    } catch {
      return undefined;
    }
  };

  const recordedNames = (): RecordedByAnother => async (name, except) =>
    (await store.list()).some(
      (stored) => stored.id !== except && stored.nativeId === name
    );

  const disposeListed = async (
    resource: DriverResourceSummary
  ): Promise<boolean> => {
    try {
      await dispose(driver, resource);
      return true;
    } catch {
      try {
        const listed = await enumerate(driver, selection, undefined);
        return !listed.some((each) => each.name === resource.name);
      } catch {
        return false;
      }
    }
  };

  const retryStuck = async (
    stuck: readonly DriverResourceSummary[],
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
        `resource ${name} kept to retry is not provably owned by this store now, so shutdown left it; ${hint(name)}`
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
      if (id === undefined || !isRowsResource(resource, id, own)) {
        passedOver.push(resource.name);
        continue;
      }
      if (
        (await store.get(id)) !== undefined ||
        (await recordedByAnother(resource.name))
      ) {
        continue;
      }
      await dispose(driver, resource);
      swept.push(resource.name);
    }
    return sweepResult(swept, passedOver);
  };

  return {
    clearRow,
    discardBooted,
    hint,
    removeAttached,
    removeSuperseded,
    retryAtShutdown,
    retryByName,
    retryStuck,
    sweep,
  };
}

function ownsNativeName(rowId: string, name: string): boolean {
  return (
    name.startsWith(`${rowId}-`) &&
    GENERATION.test(name.slice(rowId.length + 1))
  );
}

export function isForeignNativeName(rowId: string, name: string): boolean {
  return NATIVE_NAME_PATTERN.test(name) && !ownsNativeName(rowId, name);
}

const GENERATION = /^\d+$/;
const NATIVE_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/i;

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

function matchesRow(
  row: ContainerRow,
  resource: DriverResourceSummary
): boolean {
  return (
    resource.labels[CONTAINER_ID_LABEL] === row.id ||
    resource.name === row.nativeId ||
    ownsNativeName(row.id, resource.name)
  );
}

function isRowsResource(
  resource: ResourceMeta,
  rowId: string,
  storeIdentity: string
): boolean {
  const belongsToOtherRow =
    NATIVE_NAME_PATTERN.test(resource.name) &&
    !ownsNativeName(rowId, resource.name);
  return (
    !belongsToOtherRow &&
    resource.labels[CONTAINER_STORE_LABEL] === storeIdentity &&
    resource.labels[CONTAINER_ID_LABEL] === rowId
  );
}

async function dispose(
  driver: Driver,
  resource: DriverResourceSummary
): Promise<void> {
  if (ACTIVE_CONTAINER_RESOURCE_STATUSES.has(resource.status)) {
    await driver.stopResource(resource.name);
  }
  await driver.removeResource(resource.name);
}

async function enumerate(
  driver: Driver,
  labels: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined
): Promise<readonly DriverResourceSummary[]> {
  if (driver.listResources === undefined) {
    return [];
  }
  const resources: DriverResourceSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
    assertNotAborted(signal, "container sweep was cancelled");
    const result = await driver.listResources({
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
