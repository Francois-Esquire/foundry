import { isGone, thisProcess } from "@foundry/lib/node/process-identity";
import type { Layer } from "effect";
import {
  createQueueClient,
  type QueueClient,
  type QueueClientOptions,
} from "./client";
import type { InvalidPoolLimitError, StoreError } from "./domain";
import { Queue } from "./queue";
import type { QueueOptions } from "./service";
import type { QueueStore } from "./store/index";

export const nodeQueueOptions = (options: QueueOptions = {}): QueueOptions => ({
  ...options,
  identity: options.identity ?? thisProcess(),
  isOwnerGone: options.isOwnerGone ?? isGone,
});

export const nodeQueueLayer = (
  options: QueueOptions = {}
): Layer.Layer<Queue, InvalidPoolLimitError | StoreError, QueueStore> =>
  Queue.layer(nodeQueueOptions(options));

export const createNodeQueueClient = (
  options: QueueClientOptions = {}
): QueueClient => {
  const { store, ...queueOptions } = options;
  return createQueueClient({
    ...nodeQueueOptions(queueOptions),
    ...(store === undefined ? {} : { store }),
  });
};
