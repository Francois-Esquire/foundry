import type { Log } from "~/lib/log";
import type { MonitorInput } from "~/lib/monitor";
import type { Context } from "~/lib/types";
import { unbound } from "./unbound";

export function monitorContext(
  log: Log,
  signal: AbortSignal = new AbortController().signal
): Context<MonitorInput> {
  return {
    agents: unbound("agents"),
    artifacts: unbound("artifacts"),
    ask: unbound("ask"),
    exec: unbound("exec"),
    input: {},
    log,
    report: unbound("report"),
    run: unbound("run"),
    sandboxes: unbound("sandboxes"),
    signal,
    stream: unbound("stream"),
    workspaces: unbound("workspaces"),
  };
}
