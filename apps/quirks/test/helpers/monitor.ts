import { unbound } from "~/lib/bindings";
import type { Log } from "~/lib/log";
import type { Context } from "~/lib/types";
import type { MonitorInput } from "~/monitor";

/**
 * The context a detector body receives when called directly: `log` and
 * `signal` wired, every manager refusing. `{}` is a poll; a `message` is
 * what live mode hands a ws monitor.
 */
export function monitorContext(
  log: Log,
  input: MonitorInput = {},
  signal: AbortSignal = new AbortController().signal
): Context<MonitorInput> {
  return {
    agents: unbound("agents"),
    artifacts: unbound("artifacts"),
    ask: unbound("ask"),
    input,
    log,
    report: unbound("report"),
    run: unbound("run"),
    sandboxes: unbound("sandboxes"),
    signal,
    stream: unbound("stream"),
    workspaces: unbound("workspaces"),
  };
}
