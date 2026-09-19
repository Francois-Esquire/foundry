import type {
  StorageObserver,
  StorageSubscription,
} from "@foundry/core/storage";

export function polling(intervalMs = 1000): StorageObserver {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Polling interval must be positive");
  }
  return {
    watch(_root, changed) {
      const timer = setInterval(changed, intervalMs);
      return Promise.resolve({
        close() {
          clearInterval(timer);
          return Promise.resolve();
        },
      });
    },
  };
}

export async function observe(
  subscribe: (
    changed: () => void,
    failed: (error: unknown) => void
  ) => Promise<StorageSubscription | undefined>,
  refresh: () => Promise<unknown>,
  failed: (error: unknown) => void
): Promise<StorageSubscription | undefined> {
  let stopped = false;
  let dirty = false;
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  async function drain() {
    if (stopped) {
      return;
    }
    dirty = false;
    try {
      await refresh();
    } catch (error) {
      failed(error);
    }
  }

  function run(): Promise<void> {
    running ??= drain().finally(() => {
      running = undefined;
      if (dirty) {
        changed();
      }
    });
    return running;
  }

  function changed() {
    if (stopped) {
      return;
    }
    dirty = true;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Provider callbacks can run before or after subscription initialization.
    if (!ready || running || timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, 50);
  }

  const subscription = await subscribe(changed, failed);
  if (!subscription) {
    return;
  }
  ready = true;
  dirty = true;
  await run();
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        stopped = true;
        clearTimeout(timer);
        try {
          await subscription.close();
        } finally {
          await running;
        }
      })();
      return closing;
    },
  };
}
