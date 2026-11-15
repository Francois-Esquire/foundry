#!/usr/bin/env bun
import { Channel } from "~/process/channel";
import { GENERATION_NOTIFICATIONS } from "~/process/protocol";

/**
 * An engine generation that never tells its daemon of a run it let go
 * (`released`): the notice is lost, so only what the daemon reads from
 * the Marbles database can bring the run to the current generation.
 */
const { notify } = Channel.prototype;
Channel.prototype.notify = function (
  this: Channel,
  method: string,
  params?: unknown
) {
  if (method === GENERATION_NOTIFICATIONS.released) {
    return;
  }
  notify.call(this, method, params);
};
await import("~/process/generation");
