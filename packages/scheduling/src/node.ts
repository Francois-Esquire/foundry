import { isGone, thisProcess } from "@foundry/lib/node/process-identity";
import type { Layer } from "effect";
import {
  createSchedulerClient,
  type SchedulerClient,
  type SchedulerClientOptions,
} from "./client";
import type { ScheduleDispatch } from "./dispatch";
import { Scheduler, type SchedulerOptions } from "./scheduler";
import type { ScheduleStore } from "./store/index";

export const nodeSchedulerOptions = (
  options: SchedulerOptions = {}
): SchedulerOptions => ({
  ...options,
  identity: options.identity ?? thisProcess(),
  isOwnerGone: options.isOwnerGone ?? isGone,
});

export const nodeSchedulerLayer = (
  options: SchedulerOptions = {}
): Layer.Layer<Scheduler, never, ScheduleDispatch | ScheduleStore> =>
  Scheduler.layer(nodeSchedulerOptions(options));

export const createNodeSchedulerClient = (
  options: SchedulerClientOptions
): SchedulerClient => {
  const { dispatch, store, ...schedulerOptions } = options;
  return createSchedulerClient({
    ...nodeSchedulerOptions(schedulerOptions),
    dispatch,
    ...(store === undefined ? {} : { store }),
  });
};
