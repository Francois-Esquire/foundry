import type { StatusReport, WorkspaceStatus } from "./model";

export function workspaceLines(workspace: WorkspaceStatus): string[] {
  return [
    `id: ${workspace.id}`,
    `config: ${workspace.config ?? "none"}`,
    `last seen: ${workspace.lastSeen ?? "unknown"}`,
    `loop: ${workspace.alive ? `pid ${workspace.pid}` : "not running"}`,
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

export function statusText(report: StatusReport, here?: string): string {
  if (report.workspaces.length === 0) {
    return `no workspaces under ${report.root}`;
  }
  return report.workspaces
    .map((workspace) =>
      [
        `${workspace.root}${workspace.id === here ? " (here)" : ""}`,
        ...workspaceLines(workspace),
      ].join("\n")
    )
    .join("\n\n");
}
