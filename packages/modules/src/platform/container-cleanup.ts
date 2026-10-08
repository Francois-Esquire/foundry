import type {
  Container,
  Containers,
} from "@foundry/sandbox/container/containers";
import type { ContainerRuntime } from "@foundry/sandbox/container/types";

export function withConfirmedModuleContainerCleanup(
  containers: Containers,
  runtime: Pick<
    ContainerRuntime,
    "listResources" | "stopResource" | "removeResource"
  >
): Containers & { stopRetained(id: string): Promise<void> } {
  // The registry deletes its row even when native removal fails, so a retried
  // `remove` can only confirm cleanup through the native id kept here.
  const removals = new Map<string, string>();

  async function removeNative(name: string): Promise<void> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await runtime.listResources({
        labels: {},
        ...(cursor === undefined ? {} : { cursor }),
      });
      const resource = page.resources.find(
        (candidate) => candidate.name === name
      );
      if (resource !== undefined) {
        if (resource.status === "running" || resource.status === "draining") {
          await runtime.stopResource(name);
        }
        await runtime.removeResource(name);
        return;
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) {
          throw new Error(
            "Container inventory repeated a cursor during cleanup"
          );
        }
        seen.add(cursor);
      }
    } while (cursor !== undefined);
  }

  function own(handle: Container): Container {
    let failed = false;
    let nativeId: string | undefined;
    let pending: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (pending !== undefined) {
        return pending;
      }
      nativeId ??= handle.row.nativeId;
      pending = (async () => {
        if (failed && nativeId !== undefined) {
          await removeNative(nativeId);
        } else {
          await handle.close();
        }
      })().catch((error: unknown) => {
        failed = true;
        pending = undefined;
        throw error;
      });
      return pending;
    };
    // The registry handle's facets are getters over the current VM, which a
    // restart replaces. A spread would snapshot the old VM's facets; inheriting
    // from the handle keeps them live and overrides only `close`.
    return Object.freeze(
      Object.create(handle, {
        close: { enumerable: true, value: close },
      }) as Container
    );
  }

  return {
    ...containers,
    open: async (id, signal) => own(await containers.open(id, signal)),
    async remove(id) {
      const row = (await containers.list()).find(
        (candidate) => candidate.id === id
      );
      if (row?.nativeId !== undefined) {
        removals.set(id, row.nativeId);
      }
      if (row !== undefined) {
        await containers.remove(id);
      }
      const nativeId = removals.get(id);
      if (nativeId !== undefined) {
        await removeNative(nativeId);
      }
      removals.delete(id);
    },
    start: async (spec, signal) => own(await containers.start(spec, signal)),
    async stopRetained(id) {
      const row = (await containers.list()).find(
        (candidate) => candidate.id === id
      );
      if (row?.nativeId !== undefined) {
        await removeNative(row.nativeId);
      }
    },
  };
}
