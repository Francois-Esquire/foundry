import type { StatusReport, WorkspaceStatus } from "../../status/model";

export function workspaceLines(workspace: WorkspaceStatus): string[] {
  return [
    `id: ${workspace.id}`,
    `config: ${workspace.config ?? "none"}`,
    `last seen: ${workspace.lastSeen ?? "unknown"}`,
    `hosted: ${workspace.hosted ? "yes" : "no"}`,
    `process: ${workspace.alive ? `pid ${workspace.pid}${workspace.host === null ? "" : ` (${workspace.host})`}` : "not running"}`,
    `sessions: ${workspace.sessions}`,
    `artifacts: ${workspace.artifacts}`,
    "schedules",
    ...workspace.schedules.flatMap((schedule) => [
      `${schedule.name}${schedule.kind === "monitor" ? " monitor" : ""}  [${schedule.running === null ? (schedule.lastStatus ?? "never") : `pid ${schedule.running}`}]`,
      `  last ${schedule.lastFinish ?? "never"} · next ${schedule.nextDue ?? "unknown"}`,
    ]),
    ...(workspace.schedules.length === 0 ? ["none recorded"] : []),
    `runs (${workspace.runs.total})`,
    ...workspace.runs.recent.flatMap((run) => [
      `${run.step}  [${run.status}]${run.orphaned ? " orphaned (pid gone)" : ""}${run.sharedFrom === undefined ? "" : ` shared from ${run.sharedFrom}`}`,
      `  ${new Date(run.createdAt).toISOString()} · ${run.id}`,
      ...(run.steps.length === 0
        ? []
        : [
            `  steps: ${run.steps.map((step) => `${step.name} [${step.status}]`).join(" · ")}`,
          ]),
    ]),
    ...(workspace.runs.recent.length === 0 ? ["none recorded"] : []),
    ...observerLines(workspace.observers),
    ...recoveryLines(workspace.recovery),
  ];
}

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

function observerState(observer: WorkspaceStatus["observers"][number]): string {
  if (observer.stuckSince !== null) {
    return `stuck in a call since ${new Date(observer.stuckSince).toISOString()}`;
  }
  if (observer.failures > 0) {
    return `failing ×${String(observer.failures)}`;
  }
  return observer.behind === 0
    ? "caught up"
    : `${String(observer.behind)} behind`;
}

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

export function processLines(report: StatusReport): string[] {
  const { process: daemon } = report;
  return [
    daemon?.alive
      ? `marbles process: pid ${daemon.pid}${daemon.version === null ? "" : ` · v${daemon.version}`}${daemon.socket === null ? "" : ` · ${daemon.socket}`}`
      : "marbles process: not running",
    ...report.generations
      .filter(
        (generation) => generation.alive || generation.state === "cannot tell"
      )
      .map(
        (generation) =>
          `  engine generation ${String(generation.number)}: pid ${String(generation.pid)} · ${generation.state}`
      ),
  ];
}

export function statusText(report: StatusReport, here?: string): string {
  const processText = processLines(report).join("\n");
  if (report.workspaces.length === 0) {
    return `${processText}\nno workspaces under ${report.root}`;
  }
  const workspaces = report.workspaces.map((workspace) =>
    [
      `${workspace.root}${workspace.id === here ? " (here)" : ""}`,
      ...workspaceLines(workspace),
    ].join("\n")
  );
  return [processText, ...workspaces].join("\n\n");
}
