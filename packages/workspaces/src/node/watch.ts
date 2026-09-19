import { watch } from "node:fs";

import type {
  StorageObserver,
  StorageSubscription,
} from "@foundry/core/storage";

import { polling } from "../observation";

const SKIP = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;

export const nodeObserver: StorageObserver = {
  async watch(root, changed, failed) {
    let stopped = false;
    let subscription: StorageSubscription | undefined;
    let fallback: Promise<void> | undefined;
    let ready = false;
    let startupFailure: { error: unknown } | undefined;
    const notify = () => {
      if (!stopped) {
        changed();
      }
    };
    const recover = (error: unknown) => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Provider callbacks can run before or after subscription initialization.
      if (!ready) {
        startupFailure = { error };
        return;
      }
      if (stopped || fallback) {
        return;
      }
      failed(error);
      fallback = (async () => {
        await subscription?.close().catch(failed);
        if (!stopped) {
          subscription = await polling().watch(root, notify, failed);
        }
      })();
    };
    try {
      const watcher = await import("@parcel/watcher");
      const handle = await watcher.subscribe(
        root,
        (error, events) => {
          if (error) {
            recover(error);
          } else if (events.length > 0) {
            notify();
          }
        },
        { ignore: ["**/node_modules/**", "**/.git/**"] }
      );
      subscription = { close: () => handle.unsubscribe() };
    } catch {
      try {
        const handle = watch(root, { recursive: true }, (_event, filename) => {
          if (!SKIP.test(filename ?? "")) {
            notify();
          }
        });
        handle.on("error", recover);
        subscription = {
          close() {
            handle.close();
            return Promise.resolve();
          },
        };
      } catch (error) {
        failed(error);
        subscription = await polling().watch(root, notify, failed);
      }
    }
    ready = true;
    if (startupFailure) {
      recover(startupFailure.error);
    }
    return {
      async close() {
        stopped = true;
        await fallback;
        await subscription?.close();
      },
    };
  },
};
