import { watch } from "node:fs";
import type {
  StorageObserver,
  StorageSubscription,
} from "@foundry/core/storage";
import { polling } from "../observation";
import { SKIP } from "./constants";

export const nodeObserver: StorageObserver = {
  async watch(root, changed, failed) {
    let stopped = false;
    let subscription: StorageSubscription | undefined;
    let fallback: Promise<void> | undefined;
    const notify = () => {
      if (!stopped) {
        changed();
      }
    };
    const recover = (error: unknown) => {
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
    return {
      async close() {
        stopped = true;
        await fallback;
        await subscription?.close();
      },
    };
  },
};
