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
    ...observerLines(workspace.observers),
    ...recoveryLines(workspace.recovery),
  ];
}

/**
 * Each observer, a line, and a second for one that is failing or missed
 * changes: `name (source)  [caught up | N behind | failing]`.
 */
function observerLines(observers: WorkspaceStatus["observers"]): string[] {
  return [
    "observers",
    ...observers.flatMap((observer) => {
      const state = observerState(observer);
      return [
        `${observer.name} (${observer.source})  [${state}] at ${String(observer.position)}`,
        ...(observer.failures > 0
          ? [
              `  ${observer.lastError ?? "failed"} · next try ${observer.retryAt === null ? "unknown" : new Date(observer.retryAt).toISOString()}`,
            ]
          : []),
        ...(observer.missed === null
          ? []
          : [
              `  missed ${String(observer.missed.from)} to ${String(observer.missed.through)}: removed before it received them`,
            ]),
      ];
    }),
    ...(observers.length === 0 ? ["none recorded"] : []),
  ];
}

/** How an observer is faring, in a word or two. */
function observerState(observer: WorkspaceStatus["observers"][number]): string {
  if (observer.failures > 0) {
    return `failing ×${String(observer.failures)}`;
  }
  return observer.behind === 0
    ? "caught up"
    : `${String(observer.behind)} behind`;
}

/** The last start's recovery, a line per step; a failed step says so first. */
function recoveryLines(recovery: WorkspaceStatus["recovery"]): string[] {
  if (recovery === null) {
    return ["last recovery: none recorded"];
  }
  const failed = recovery.steps.filter((step) => step.outcome === "failed");
  return [
    `last recovery: ${recovery.at}${failed.length === 0 ? "" : ` · ${String(failed.length)} step(s) failed`}`,
    ...recovery.steps.map(
      (step) => `  ${step.step}  [${step.outcome}] ${step.detail}`
    ),
  ];
}

function processLine(report: StatusReport): string {
  const { process: daemon } = report;
  if (daemon?.alive) {
    return [
      `marbles process: pid ${daemon.pid}${daemon.version === null ? "" : ` · v${daemon.version}`}${daemon.socket === null ? "" : ` · ${daemon.socket}`}`,
      ...report.generations
        .filter((generation) => generation.alive)
        .map(
          (generation) =>
            `  engine generation ${String(generation.number)}: pid ${String(generation.pid)} · ${generation.state}`
        ),
    ].join("\n");
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
