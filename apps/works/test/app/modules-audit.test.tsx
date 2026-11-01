import "../helpers/mock-module-source";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { AuditRun } from "~/shared/audit";
import { renderApp } from "../helpers/render-app";

const audit = vi.hoisted(() => ({
  current: undefined as
    | ReturnType<typeof import("../helpers/audit-runs").fixtureAudit>
    | undefined,
}));

vi.mock("~/app/api/client", async () => {
  const { fakeApi, fakeStorage, openFakeVault } = await import(
    "../helpers/fake-api"
  );
  const { fixtureAudit } = await import("../helpers/audit-runs");
  audit.current = fixtureAudit();
  const { fixture } = audit.current;
  const storage = fakeStorage();
  const api = fakeApi(
    await openFakeVault(),
    { ...storage.modules, list: () => Promise.resolve([...fixture.modules]) },
    {
      artifacts: {
        ...storage.explorer,
        list: () => Promise.resolve([...fixture.artifacts]),
      },
      audit: audit.current.audit,
    }
  );
  return { worksApi: () => api };
});

function current() {
  if (!audit.current) {
    throw new Error("The audit fixture is not loaded");
  }
  return audit.current;
}

beforeEach(() => {
  const { fixture, state } = current();
  state.failNext = 0;
  state.gaps = [...fixture.gaps];
  state.runs = new Map(fixture.runs.map((run) => [run.id, run]));
});
afterEach(cleanup);

const COVERAGE = /model turns? reported token usage/;

async function panel(name: string) {
  return await screen.findByRole("tabpanel", { name });
}

async function table(name: string) {
  return await screen.findByRole("table", { name });
}

function rowsOf(element: HTMLElement) {
  // The first row is the header.
  return within(element).getAllByRole("row").slice(1);
}

it("puts the audit tabs beside Catalog", async () => {
  renderApp("/modules");
  const tabs = within(
    await screen.findByRole("tablist", { name: "Modules sections" })
  ).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Catalog",
    "Dashboard",
    "Calls",
    "Workflow Runs",
    "Execution Runs",
    "Artifact Saves",
  ]);
  fireEvent.mouseDown(tabs[1] as HTMLElement);
  expect(await panel("Dashboard")).toBeDefined();
  // Arrow keys move between tabs, selecting the one they reach.
  fireEvent.keyDown(tabs[1] as HTMLElement, { key: "ArrowRight" });
  expect(await panel("Calls")).toBeDefined();
});

it("summarizes runs and usage with unknowns left unknown", async () => {
  renderApp("/modules?tab=dashboard");
  const dashboard = await panel("Dashboard");
  expect(
    await within(dashboard).findByText("Unknown — no provider reported cost")
  ).toBeDefined();
  const runs = within(dashboard).getByText("Runs", { selector: "dt" });
  expect(runs.nextSibling?.textContent).toBe(
    String(current().fixture.runs.length)
  );
  expect(within(dashboard).getByText(COVERAGE)).toBeDefined();
  const kinds = rowsOf(await table("Runs by kind")).map(
    (row) => row.firstChild?.textContent
  );
  expect(kinds).toEqual(
    expect.arrayContaining([
      "Build",
      "Chat turn",
      "File save",
      "Release publish",
      "Source save",
      "App (Program lifetime)",
      "Workflow works.examples.ticker@1",
    ])
  );
  // Scope and time range are explicit controls.
  expect(screen.getByLabelText("Module")).toBeDefined();
  expect((screen.getByLabelText("Time range") as HTMLSelectElement).value).toBe(
    "all"
  );
});

it("lists model turns and tool calls from a real coding turn, and Gateway calls, linked to Module and run", async () => {
  const { fixture } = current();
  renderApp("/modules?tab=calls");
  const calls = await table("Calls");
  const rows = rowsOf(calls).map((row) =>
    within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent)
  );
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.arrayContaining(["Tool call", "write", "Chat test", "Complete"]),
      expect.arrayContaining([
        "Gateway",
        "works.system.theme@1",
        "Weather desk",
      ]),
      expect.arrayContaining(["Gateway", "works.artifacts.save@1"]),
    ])
  );
  expect(rows.some((cells) => cells[0] === "Model turn")).toBe(true);
  expect(
    within(calls).getAllByRole("link", { name: `Run ${fixture.turnRunId}` })
      .length
  ).toBeGreaterThan(0);
  expect(
    within(calls).getAllByRole("link", { name: "Weather desk" })[0]
  ).toHaveProperty(
    "href",
    expect.stringContaining(`/modules/${fixture.moduleId}`)
  );
});

it("scopes every tab to one Module", async () => {
  const { fixture } = current();
  renderApp(`/modules?tab=calls&module=${fixture.moduleId}`);
  const rows = rowsOf(await table("Calls"));
  expect(rows.map((row) => row.firstChild?.textContent)).toEqual([
    "Gateway",
    "Gateway",
  ]);
});

it("shows registered workflow runs with progress and outcome", async () => {
  renderApp("/modules?tab=workflows");
  const rows = rowsOf(await table("Workflow runs"));
  expect(rows).toHaveLength(1);
  expect(
    within(rows[0] as HTMLElement)
      .getAllByRole("cell")
      .map((cell) => cell.textContent)
  ).toEqual(
    expect.arrayContaining([
      "works.examples.ticker@1",
      "Weather desk",
      "Complete",
      "2 of 2",
    ])
  );
});

it("lists every run, and only failed save attempts under the attempts filter", async () => {
  const { fixture } = current();
  renderApp("/modules?tab=executions");
  const all = rowsOf(await table("Execution runs"));
  expect(all).toHaveLength(fixture.runs.length);
  fireEvent.click(screen.getByLabelText("Failed save attempts only"));
  const attempts = rowsOf(await table("Failed save attempts"));
  expect(
    attempts.map((row) => row.firstChild?.textContent?.split("rn-")[0])
  ).toEqual(["File save", "Source save"]);
  expect(
    within(attempts[0] as HTMLElement).getByText("Not saved: conflict")
  ).toBeDefined();
});

it("lists committed saves only, with kind, origin and recovery", async () => {
  renderApp("/modules?tab=saves");
  const rows = rowsOf(await table("Artifact saves")).map((row) =>
    within(row)
      .getAllByRole("cell")
      .slice(0, 3)
      .map((cell) => cell.textContent)
  );
  expect(rows).toHaveLength(4);
  expect(rows).toEqual(
    expect.arrayContaining([
      ["Field notesnotes.md", "File (created)", "You"],
      ["Field notesnotes.md", "File", "You"],
      ["Weather desk", "Source", "You"],
      ["Weather desk", "Release 0.1.0", "Build"],
    ])
  );
});

it("follows live changes, shows retention gaps, and recovers from a dropped connection", async () => {
  const { change, fixture, state } = current();
  state.gaps = [
    {
      removed: 12,
      scope: `module:${fixture.moduleId}`,
      through: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    },
  ];
  state.failNext = 1;
  renderApp("/modules?tab=executions");
  // The first watch fails; the view says so, then reconnects by itself.
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Activity could not be loaded")
  );
  await table("Execution runs");
  expect(
    screen.getByRole("region", { name: "Retention" }).textContent
  ).toContain("Weather desk: 12 runs");

  const [workflow] = fixture.runs.filter(
    (run) => run.correlation.workflow !== undefined
  );
  if (!workflow) {
    throw new Error("no workflow run");
  }
  const later: AuditRun = {
    ...workflow,
    id: "rn-live-run",
    revision: 1,
    sequence: workflow.sequence + 10_000,
    status: "running",
  };
  change(later);
  await waitFor(() =>
    expect(screen.getAllByText("rn-live-run")).toHaveLength(1)
  );
  change({ ...later, revision: 2, status: "complete" });
  // The same revision again changes nothing; the row is not duplicated.
  change({ ...later, revision: 2, status: "complete" });
  await waitFor(() =>
    expect(
      within(
        screen.getByText("rn-live-run").closest("tr") as HTMLElement
      ).getAllByText("Complete").length
    ).toBe(1)
  );
  expect(screen.getAllByText("rn-live-run")).toHaveLength(1);
});

it("keeps a time range sliding while the view stays open", async () => {
  const { fixture } = current();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  renderApp("/modules?tab=executions&range=1d");
  // Every fixture run was queued moments ago.
  expect(rowsOf(await table("Execution runs"))).toHaveLength(
    fixture.runs.length
  );
  // A day later, with nothing new from the run store, they have aged out.
  act(() => {
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
  });
  await screen.findByText("No runs in this scope and time range.");
});
