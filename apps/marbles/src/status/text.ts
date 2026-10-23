import type { StatusReport, WorkspaceStatus } from "./model";

export function workspaceLines(workspace: WorkspaceStatus): string[] {
  return [
    `id: ${workspace.id}`,
    `config: ${workspace.config ?? "none"}`,
    `last seen: ${workspace.lastSeen ?? "unknown"}`,
    `hosted: ${workspace.hosted ? "yes" : "no"}`,
    `process: ${workspace.alive ? `pid ${workspace.pid}${workspace.host === null ? "" : ` (${workspace.host})`}` : "not running"}`,
    `sessions: ${workspace.sessions}`,
    "schedules",
    ...workspace.schedules.flatMap((schedule) => [
      `${schedule.name}${schedule.kind === "monitor" ? " monitor" : ""}  [${schedule.running === null ? (schedule.lastStatus ?? "never") : `pid ${schedule.running}`}]`,
      `  last ${schedule.lastFinish ?? "never"} · next ${schedule.nextDue ?? "unknown"}`,
    ]),
    ...(workspace.schedules.length === 0 ? ["none recorded"] : []),
    `runs (${workspace.runs.total})`,
    ...workspace.runs.recent.flatMap((run) => [
      `${run.step}  [${run.status}]${run.orphaned ? " orphaned (pid gone)" : ""}`,
      `  ${new Date(run.createdAt).toISOString()} · ${run.id}`,
    ]),
    ...(workspace.runs.recent.length === 0 ? ["none recorded"] : []),
  ];
}

/** The daemon's line: who answers for this state root, and where. */
export function processLine(report: StatusReport): string {
  const { process: daemon } = report;
  if (daemon?.alive) {
    return `marbles process: pid ${daemon.pid}${daemon.version === null ? "" : ` · v${daemon.version}`}${daemon.socket === null ? "" : ` · ${daemon.socket}`}`;
  }
  return "marbles process: not running";
}

export function statusText(report: StatusReport, here?: string): string {
  if (report.workspaces.length === 0) {
    return `${processLine(report)}\nno workspaces under ${report.root}`;
  }
  const workspaces = report.workspaces.map((workspace) =>
    [
      `${workspace.root}${workspace.id === here ? " (here)" : ""}`,
      ...workspaceLines(workspace),
    ].join("\n")
  );
  return [processLine(report), ...workspaces].join("\n\n");
}
