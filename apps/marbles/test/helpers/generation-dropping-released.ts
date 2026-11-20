#!/usr/bin/env bun
import { Channel } from "~/process/channel";
import { GENERATION_NOTIFICATIONS } from "~/process/protocol";

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
