#!/usr/bin/env bun
import { HostedWorkspaces } from "~/workspace/hosted";

/**
 * An engine generation whose unhosting of a workspace drops the
 * registration only a while later, as a host whose close takes a while
 * would, and that says, as its hosts close, how many of those are still
 * under way: none may be, or the registration is dropped through a
 * closed database handle.
 */
let unregistering = 0;
const { close, unregister } = HostedWorkspaces.prototype;
HostedWorkspaces.prototype.unregister = async function (
  this: HostedWorkspaces,
  ...args: Parameters<HostedWorkspaces["unregister"]>
) {
  unregistering += 1;
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return await unregister.apply(this, args);
  } finally {
    unregistering -= 1;
  }
};
HostedWorkspaces.prototype.close = function (this: HostedWorkspaces) {
  process.stderr.write(
    `hosts closing with ${String(unregistering)} unregister(s) under way\n`
  );
  return close.call(this);
};
await import("~/process/generation");
