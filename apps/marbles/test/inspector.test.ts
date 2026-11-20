import { describe, expect, it } from "vitest";
import {
  type DashboardSelection,
  resolveSelection,
  runSelection,
  selectionKey,
} from "~/cli/state/dashboard-model";
import { inspectorSubject, runLogs } from "~/cli/state/inspector";
import type { HarnessActivitySnapshot } from "~/model/dashboard";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";

const OTHER = { id: "ws-other", name: "other" };

const activity: HarnessActivitySnapshot = {
  agentId: "doc-writer",
  attention: "question",
  harness: "claude",
  id: "act-1",
  kind: "subagent",
  lifetime: "session",
  revision: 1,
  sessionId: "session-1",
  status: "running",
  title: "Draft the reference",
};

function subjectOf(selection?: DashboardSelection) {
  return inspectorSubject(
    dashboardSnapshot,
    resolveSelection(dashboardSnapshot, selection)
  );
}

function firstRun() {
  const [run] = dashboardSnapshot.runs;
  if (!run) {
    throw new Error("fixture has no runs");
  }
  return run;
}

describe("inspectorSubject", () => {
  it("prompts for a selection, and explains one that is gone", () => {
    expect(subjectOf()).toEqual({
      kind: "message",
      message: "Select a schedule, monitor, definition, run, or step.",
      title: "Details",
    });
    expect(subjectOf({ id: "missing", kind: "definition" })).toMatchObject({
      message: "This item is no longer available.",
    });
    expect(
      subjectOf({ id: "run-104", kind: "run", stepId: "x" })
    ).toMatchObject({
      message: "This step is no longer available in run run-104.",
    });
  });

  it("builds a run inspector with breadcrumbs, trigger, and stream target", () => {
    const run = firstRun();
    const subject = subjectOf(runSelection(run));
    if (subject.kind !== "run") {
      throw new Error(`expected a run, got ${subject.kind}`);
    }
    expect(subject.title).toBe("Run / update-documentation");
    expect(subject.stream).toEqual({ local: true, runId: "run-104" });
    expect(subject.inspector.breadcrumbs).toEqual([
      {
        id: "breadcrumb:run",
        key: selectionKey(runSelection(run)),
        label: "run-104",
        selection: runSelection(run),
      },
    ]);
    expect(subject.inspector.overview).toMatchObject({
      kind: "run",
      run: { currentStep: "Write changes", trigger: "update-docs" },
    });
  });

  it("follows a step's path and scopes its stream", () => {
    const run = firstRun();
    const subject = subjectOf(runSelection(run, { stepId: "write" }));
    if (subject.kind !== "run") {
      throw new Error(`expected a run, got ${subject.kind}`);
    }
    expect(subject.title).toBe("Step / Write changes");
    expect(subject.stream.stepId).toBe("write");
    expect(subject.inspector.breadcrumbs.map(({ label }) => label)).toEqual([
      "run-104",
      "› Update documentation",
      "› Write changes",
    ]);
    expect(subject.inspector.overview.kind).toBe("step");
  });

  it("describes a schedule that can run now, with its runs", () => {
    const subject = subjectOf({ id: "daily", kind: "trigger" });
    if (subject.kind !== "catalog") {
      throw new Error(`expected a catalog item, got ${subject.kind}`);
    }
    expect(subject).toMatchObject({
      launchable: false,
      runNow: true,
      title: "Schedule / daily-summary",
    });
    expect(subject.details.facts[0]).toEqual({
      key: "Target",
      value: "summarize-day",
    });
    expect(subject.details.configuration).toContain('"time": "17:00"');
    expect(subject.details.filter).toEqual({ id: "daily", kind: "trigger" });
  });

  it("describes a definition with its usage and launch", () => {
    const subject = subjectOf({ id: "docs", kind: "definition" });
    if (subject.kind !== "catalog") {
      throw new Error(`expected a catalog item, got ${subject.kind}`);
    }
    expect(subject).toMatchObject({ launchable: true, runNow: false });
    expect(subject.details.configuration).toBeUndefined();
    expect(subject.details.runs.map(({ runId }) => runId)).toContain("run-104");
    expect(
      subject.details.facts.find(({ key }) => key === "Source")?.value
    ).toBe(".foundry/marbles/docs.ts:12");
  });
});

describe("inspectorSubject across workspaces and activities", () => {
  it("shows an activity, its breadcrumb naming only the run id", () => {
    const run = { ...firstRun(), activities: [activity], workspace: OTHER };
    const snapshot = { ...dashboardSnapshot, runs: [run] };
    const subject = inspectorSubject(
      snapshot,
      resolveSelection(
        snapshot,
        runSelection(run, { activityId: "act-1", sessionId: "session-1" })
      )
    );
    if (subject.kind !== "activity") {
      throw new Error(`expected an activity, got ${subject.kind}`);
    }
    expect(subject.title).toBe("Activity");
    expect(subject.activity).toMatchObject({
      breadcrumb: {
        label: "run-104",
        selection: { id: "run-104", kind: "run" },
      },
      title: "Draft the reference",
      waiting: true,
    });
    expect(subject.activity.facts.map(({ key }) => key)).toEqual([
      "Kind",
      "Status",
      "Harness",
      "Agent",
      "Lifetime",
      "Session",
      "Activity",
    ]);
  });

  it("does not stream a run another workspace owns", () => {
    const run = { ...firstRun(), workspace: OTHER };
    const snapshot = { ...dashboardSnapshot, runs: [run] };
    const subject = inspectorSubject(
      snapshot,
      resolveSelection(snapshot, runSelection(run))
    );
    expect(subject).toMatchObject({ kind: "run", stream: { local: false } });
  });

  it("does not offer to run another workspace's schedule now", () => {
    const [, , daily] = dashboardSnapshot.triggers;
    if (!daily) {
      throw new Error("fixture has no schedule");
    }
    const trigger = { ...daily, workspace: OTHER };
    const snapshot = { ...dashboardSnapshot, triggers: [trigger] };
    const subject = inspectorSubject(
      snapshot,
      resolveSelection(snapshot, {
        id: "daily",
        kind: "trigger",
        workspace: "ws-other",
      })
    );
    expect(subject).toMatchObject({ kind: "catalog", runNow: false });
  });
});

describe("runLogs", () => {
  it("keeps a step's own lines and its children's", () => {
    const run = firstRun();
    const update = run.steps.find((step) => step.id === "update");
    expect(runLogs(run, undefined)).toHaveLength(run.logs?.length ?? 0);
    expect(runLogs(run, update).map(({ stepId }) => stepId)).toEqual([
      "read",
      "write",
    ]);
  });
});
