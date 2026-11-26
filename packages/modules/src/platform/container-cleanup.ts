import type {
  CONTAINER_ID_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  Container,
  ContainerResourceStatus,
  ContainerRuntime,
  Containers,
} from "@foundry/sandbox";

const ID_LABEL: typeof CONTAINER_ID_LABEL = "com.foundry.container.id";
const MANAGED_BY_LABEL: typeof CONTAINER_MANAGED_BY_LABEL =
  "com.foundry.environment.managed-by";
const MANAGED_BY_VALUE: typeof CONTAINER_MANAGED_BY_VALUE = "foundry-sandbox";
const NEEDS_STOP: Readonly<Record<ContainerResourceStatus, boolean>> = {
  crashed: false,
  created: false,
  draining: true,
  paused: true,
  running: true,
  starting: true,
  stopped: false,
};

export function withConfirmedModuleContainerCleanup(
  containers: Containers,
  runtime: Pick<
    ContainerRuntime,
    "listResources" | "stopResource" | "removeResource"
  >
): Containers & { stopRetained(id: string): Promise<void> } {
  async function removeNative(rowId: string, name: string): Promise<void> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await runtime.listResources({
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [ID_LABEL]: rowId,
        },
        ...(cursor === undefined ? {} : { cursor }),
      });
      const resource = page.resources.find(
        (candidate) => candidate.name === name
      );
      if (resource !== undefined) {
        if (NEEDS_STOP[resource.status]) {
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
          await removeNative(handle.id, nativeId);
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
      if ((await containers.get(id)) !== undefined) {
        await containers.remove(id);
      }
    },
    start: async (spec, signal) => own(await containers.start(spec, signal)),
    async stopRetained(id) {
      const row = await containers.get(id);
      if (row?.nativeId !== undefined) {
        await removeNative(id, row.nativeId);
      }
    },
  };
}

export class ModuleRuntimeCleanupError extends Error {
  readonly cleanup: () => Promise<void>;

  constructor(cleanup: () => Promise<void>, options: ErrorOptions) {
    super("Module runtime cleanup is incomplete", options);
    this.cleanup = cleanup;
    this.name = "ModuleRuntimeCleanupError";
  }
}

export async function rethrowAfterCleanup(
  error: unknown,
  cleanup: () => Promise<void>,
  message: string
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    // biome-ignore lint/style/useErrorCause: The cause is an AggregateError holding both the original failure and `cleanupError`, so the owner sees each.
    throw new ModuleRuntimeCleanupError(cleanup, {
      cause: new AggregateError([error, cleanupError], message, {
        cause: error,
      }),
    });
  }
  throw error;
}
