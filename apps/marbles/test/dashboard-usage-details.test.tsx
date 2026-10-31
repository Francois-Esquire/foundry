import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { step } from "../src/authoring/builder";
import { catalog } from "../src/authoring/catalog";
import { agent } from "../src/authoring/resources";
import { dashboardSnapshot } from "../src/dashboard/snapshot";
import { JsonSessionStore } from "../src/lib/sessions/json-store";
import { JsonStateStore } from "../src/lib/state/store";
import type { SessionRef } from "../src/lib/types";
import { DashboardView } from "../src/views/dashboard";
import type { DashboardSnapshot } from "../src/views/dashboard-model";
import { startEngine } from "./helpers/engine";
import { flush, mount, press, unmount } from "./helpers/render";

const WARNING = "may be incomplete: 1 unreadable usage record";
const PANEL_TEXT = /[│█▀▄\s]+/g;

/** The frame's words in order, so a value wrapped inside a panel still reads as one line. */
function words(frame: string): string {
  return frame.replace(PANEL_TEXT, " ");
}

function close() {
  // Quitting is covered in dashboard-quit.test.tsx.
}

let state: string | undefined;

afterEach(async () => {
  await unmount();
  catalog.reset();
  if (state) {
    rmSync(state, { force: true, recursive: true });
  }
  state = undefined;
});

/**
 * A real run with one priced leaf and one malformed leaf in its document on
 * disk, read back by a new engine the way the dashboard host reads it.
 */
async function damagedSnapshot(): Promise<DashboardSnapshot> {
  state = mkdtempSync(join(tmpdir(), "marbles-details-"));
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  step("priced").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    await session.generate("one");
  });
  const dir = state;
  // Durable sessions beside durable state, as the host builds an engine.
  const durable = () => ({
    print: () => undefined,
    sessions: new JsonSessionStore(join(dir, "sessions")),
    state: dir,
  });
  const first = await startEngine(durable());
  const launched = await first.launch("priced", {});
  await launched.result;
  await first.dispose();
  const disk = new JsonStateStore(state);
  const key = `run.${encodeURIComponent(launched.id)}`;
  const document = disk.read("usage", key) as {
    facts: Record<string, Record<string, unknown>>;
  };
  const [saved] = Object.values(document.facts);
  if (!saved) {
    throw new Error("expected a saved fact");
  }
  saved.cost = {
    amount: 2,
    currency: "USD",
    kind: "reported",
    reference: "probe",
  };
  document.facts.broken = {
    ...saved,
    cost: { amount: "bad" },
    turnId: "broken",
  };
  disk.write("usage", key, document);
  const second = await startEngine(durable());
  const snapshot = dashboardSnapshot(await second.runs(), {
    definitions: second.definitions(),
    lastFinish: new Map(),
    monitors: second.monitors(),
    root: state,
    schedules: [],
    startedAt: 0,
    status: "",
    usage: await second.readUsage(),
    workspaceId: "test",
  });
  await second.dispose();
  return snapshot;
}

async function scrollToEnd(ui: Awaited<ReturnType<typeof mount>>) {
  for (let line = 0; line < 12; line += 1) {
    await act(async () => ui.mockInput.pressArrow("down"));
  }
  await flush(ui);
}

test("run, step and workflow details at 80 columns say a total may be incomplete when an unreadable record may belong to it", async () => {
  const snapshot = await damagedSnapshot();
  const ui = await mount(
    <DashboardView onClose={close} snapshot={snapshot} />,
    {
      height: 24,
      width: 80,
    }
  );
  expect(ui.captureCharFrame()).toContain("$2.00+?");
  // Run details, scrolled to the cost lines.
  await press(ui, "RETURN");
  await scrollToEnd(ui);
  let frame = words(ui.captureCharFrame());
  expect(frame).toContain(`$2.00 reported · ${WARNING}`);
  // Step details.
  await press(ui, "ESCAPE");
  await press(ui, "ARROW_DOWN");
  await press(ui, "RETURN");
  await scrollToEnd(ui);
  frame = words(ui.captureCharFrame());
  expect(frame).toContain(`Cost here : $2.00 reported · ${WARNING}`);
  // Workflow details in the catalog.
  await press(ui, "ESCAPE");
  await press(ui, "2");
  await press(ui, "RETURN");
  await scrollToEnd(ui);
  frame = words(ui.captureCharFrame());
  expect(frame).toContain("Available");
  expect(frame).toContain(`$2.00 reported · ${WARNING}`);
  // Overview's usage breakdown names it too.
  await press(ui, "ESCAPE");
  await press(ui, "3");
  await press(ui, "u");
  expect(ui.captureCharFrame()).toContain("1 usage records could not be read");
});

test("a workflow with no valid facts shows unowned unreadable usage in its Catalog details instead of 'no usage recorded'", async () => {
  state = mkdtempSync(join(tmpdir(), "marbles-details-"));
  const dir = state;
  const durable = () => ({
    print: () => undefined,
    sessions: new JsonSessionStore(join(dir, "sessions")),
    state: dir,
  });
  step("healthy").do(() => "no agents here");
  const first = await startEngine(durable());
  const launched = await first.launch("healthy", {});
  await launched.result;
  await first.dispose();
  // A usage document whose name says nothing about its owner, and cannot be read.
  new JsonStateStore(dir).write("usage", "mystery", { facts: "broken" });
  const second = await startEngine(durable());
  const snapshot = dashboardSnapshot(await second.runs(), {
    definitions: second.definitions(),
    lastFinish: new Map(),
    monitors: second.monitors(),
    root: dir,
    schedules: [],
    startedAt: 0,
    status: "",
    usage: await second.readUsage(),
    workspaceId: "test",
  });
  await second.dispose();
  const ui = await mount(
    <DashboardView onClose={close} snapshot={snapshot} />,
    { height: 24, width: 80 }
  );
  await press(ui, "2");
  await press(ui, "RETURN");
  await scrollToEnd(ui);
  const frame = words(ui.captureCharFrame());
  expect(frame).toContain("Available");
  expect(frame).toContain(
    "Cost : unknown · 1 unreadable usage record may belong here"
  );
  expect(frame).toContain(
    "Tokens : tokens unknown · 1 unreadable usage record may belong here"
  );
  expect(frame).not.toContain("no usage recorded");
});

test("a known workflow whose running run the reader cannot load shows an unattributed turn, or once the transcript cannot be read an unreadable record, in its Catalog details instead of 'no usage recorded'", async () => {
  state = mkdtempSync(join(tmpdir(), "marbles-details-"));
  const dir = state;
  const durable = () => ({
    print: () => undefined,
    sessions: new JsonSessionStore(join(dir, "sessions")),
    state: dir,
  });
  const helper = agent({ name: "helper", prompt: "Help." });
  let ref: SessionRef | undefined;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opened: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const consumer = () =>
    step("consumer").do(async ({ agents }) => {
      if (ref) {
        const session = await agents.session(helper, { session: ref });
        await session.generate("fact and marker both fail");
        opened();
        await gate;
      }
    });
  consumer();
  const host = await startEngine(durable());
  const direct = await host.agents.session(helper);
  await direct.generate("saved direct turn");
  ({ ref } = direct);
  const usageDir = join(dir, "usage");
  const transcript = join(dir, "sessions", `${direct.ref.id}.json`);
  const { mode } = statSync(transcript);
  const writer = await startEngine(durable());
  // A fresh reader: the consumer's run is still running in another engine.
  const catalogDetails = async (): Promise<string> => {
    catalog.reset();
    consumer();
    const reader = await startEngine(durable());
    const snapshot = dashboardSnapshot(await reader.runs(), {
      definitions: reader.definitions(),
      lastFinish: new Map(),
      monitors: reader.monitors(),
      root: dir,
      schedules: [],
      startedAt: 0,
      status: "",
      usage: await reader.readUsage(),
      workspaceId: "test",
    });
    await reader.dispose();
    expect(snapshot.runs).toEqual([]);
    const ui = await mount(
      <DashboardView onClose={close} snapshot={snapshot} />,
      { height: 24, width: 80 }
    );
    await press(ui, "2");
    await press(ui, "RETURN");
    await scrollToEnd(ui);
    const frame = words(ui.captureCharFrame());
    await unmount();
    return frame;
  };
  try {
    chmodSync(usageDir, 0o500);
    const running = await writer.launch("consumer", {});
    await ready;
    const frame = await catalogDetails();
    expect(frame).toContain("consumer");
    expect(frame).toContain(
      "Cost : unknown · 1 unattributed turn may belong here"
    );
    expect(frame).not.toContain("no usage recorded");
    // Only direct facts name the unreadable transcript; its loss is not theirs alone.
    chmodSync(transcript, 0o000);
    const blind = await catalogDetails();
    chmodSync(transcript, mode);
    expect(blind).toContain("consumer");
    expect(blind).toContain(
      "Cost : unknown · 1 unreadable usage record may belong here"
    );
    expect(blind).not.toContain("no usage recorded");
    chmodSync(usageDir, 0o700);
    release();
    await running.result;
  } finally {
    chmodSync(transcript, mode);
    chmodSync(usageDir, 0o700);
    release();
    await writer.dispose();
    await host.dispose();
  }
});
