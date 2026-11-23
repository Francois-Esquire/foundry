import { afterEach, expect, test } from "vitest";
import type { Thread } from "../src/model/thread";
import { HarnessView } from "../src/views/harness";
import { context, threads } from "../stories/fixtures/threads";
import { fakeRun } from "./helpers/fake-run";

import { frameWith, mount, press, type, unmount } from "./helpers/render";

function view(thread: Thread) {
  const fake = fakeRun(thread);
  return { fake, node: <HarnessView context={context} run={fake.run} /> };
}

async function asked(thread: Thread, size?: { height: number; width: number }) {
  const { fake, node } = view(thread);
  const ui = await mount(node, size);
  await type(ui, "explain this example");
  await press(ui, "RETURN");
  return { fake, ui };
}

const PAGE_UP = "\u001B[5~";
const PAGE_DOWN = "\u001B[6~";

afterEach(unmount);

test("a new view shows the welcome and an empty panel", async () => {
  const frame = (await mount(view(threads.idle).node)).captureCharFrame();

  expect(frame).toContain("Give the harness a goal. It will:");
  expect(frame).toContain("No to-dos yet.");
  expect(frame).toContain("0/0 · New thread");
  expect(frame).toContain("GUN  SONNET");
});

test("Enter hands over a trimmed goal once and clears the field", async () => {
  const { fake, node } = view(threads.done);
  const ui = await mount(node);

  await press(ui, "RETURN");
  await type(ui, "  list the files  ");
  expect(ui.captureCharFrame()).toContain("list the files");
  await press(ui, "RETURN");
  await press(ui, "RETURN");

  expect(fake.goals).toEqual(["list the files"]);
  expect(fake.weapons).toEqual([{ effort: "medium", model: "sonnet" }]);
  expect(ui.captureCharFrame()).toContain("Accept, reject or skip the result");
  expect(ui.captureCharFrame()).toContain("18.4k in · 912 out");
});

test("Enter does nothing while a goal is running", async () => {
  const { fake, ui } = await asked(threads.planning);

  expect(ui.captureCharFrame()).toContain("Planning the goal into to-dos");
  await type(ui, "another goal");
  await press(ui, "RETURN");

  expect(fake.goals).toEqual(["explain this example"]);
  expect(ui.captureCharFrame()).toContain("another goal");
});

test("the picked weapon and avatar stay for every goal and the arrows only browse the loadout", async () => {
  const fake = fakeRun(threads.done);
  const ui = await mount(
    <HarnessView
      context={context}
      picks={{ avatar: 1, effort: "high", model: "opus" }}
      run={fake.run}
    />,
    { height: 44, width: 120 }
  );

  expect(ui.captureCharFrame()).toContain("WELDER");
  await press(ui, "TAB");
  await press(ui, "ARROW_DOWN");
  expect(ui.captureCharFrame()).toContain("GUN  OPUS");
  expect(ui.captureCharFrame()).toContain("AMMO ▮▮▮");
  expect(ui.captureCharFrame()).toContain("WELDER");
  expect(ui.captureCharFrame()).toContain("▶ 02 backlog");

  await type(ui, "explain this example");
  await press(ui, "RETURN");
  expect(fake.goals).toEqual(["explain this example"]);
  expect(fake.weapons).toEqual([{ effort: "high", model: "opus" }]);
});

test("the arrows leave the goal being typed alone", async () => {
  const { node } = view(threads.idle);
  const ui = await mount(node, { height: 44, width: 120 });

  await type(ui, "list the files");
  await press(ui, "ARROW_DOWN");

  expect(ui.captureCharFrame()).toContain("› list the files");
  expect(ui.captureCharFrame()).toContain("GUN  SONNET");
});

test("PgUp and PgDn scroll the conversation", async () => {
  const { ui } = await asked(threads.done, { height: 16, width: 120 });
  const top = "You";
  const bottom = await frameWith(ui, "bun run start");

  expect(bottom).not.toContain(top);
  for (let page = 0; page < 8; page += 1) {
    await press(ui, PAGE_UP);
  }
  const scrolled = await frameWith(ui, top);
  expect(scrolled).toContain(top);
  expect(scrolled).not.toContain("bun run start");
  for (let page = 0; page < 8; page += 1) {
    await press(ui, PAGE_DOWN);
  }
  const back = await frameWith(ui, "bun run start");
  expect(back).toContain("bun run start");
  expect(back).not.toContain(top);
});

test("A accepts the finished goal and hands the keys back to the goal field", async () => {
  const { ui } = await asked(threads.done, { height: 44, width: 120 });

  expect(await frameWith(ui, "awaiting verdict")).toContain("A  Accept");
  expect(ui.captureCharFrame()).toContain("LV 1");
  await press(ui, "a");

  const frame = await frameWith(ui, "RANK S");
  expect(frame).toContain("RANK S · +175 XP");
  expect(frame).toContain("LV 2");
  expect(frame).toContain("75/200 xp");
  expect(frame).not.toContain("A  Accept");
  await type(ui, "a rare goal");
  expect(ui.captureCharFrame()).toContain("› a rare goal");
  expect(ui.captureCharFrame()).toContain("RANK S · +175 XP");
});

test("R rejects the finished goal and banks nothing", async () => {
  const { ui } = await asked(threads.done, { height: 44, width: 120 });

  await press(ui, "r");

  const frame = await frameWith(ui, "Rejected");
  expect(frame).toContain("Rejected · nothing banked");
  expect(frame).toContain("LV 1");
  expect(frame).toContain("0/100 xp");
});

test("Escape skips the verdict, hides the card and banks nothing", async () => {
  const { ui } = await asked(threads.done, { height: 44, width: 120 });

  await frameWith(ui, "awaiting verdict");
  await type(ui, "hello");
  expect(ui.captureCharFrame()).not.toContain("› hello");
  await press(ui, "ESCAPE");

  const frame = ui.captureCharFrame();
  expect(frame).not.toContain("RESULTS");
  expect(frame).toContain("0/100 xp");
  await type(ui, "next");
  expect(ui.captureCharFrame()).toContain("› next");
});

test("the verdict keys go to the goal field while a goal runs", async () => {
  const { ui } = await asked(threads.working, { height: 44, width: 120 });

  await press(ui, "a");

  expect(ui.captureCharFrame()).not.toContain("RESULTS");
  expect(ui.captureCharFrame()).toContain("LV 1");
});

test("a narrow terminal drops the panel and ignores Tab", async () => {
  const { ui } = await asked(threads.done, { height: 24, width: 60 });
  const before = await frameWith(ui, "bun run start");
  await press(ui, "TAB");

  expect(before).not.toContain("VITALS");
  expect(before).not.toContain("Tab");
  expect(before.trimEnd().split("\n")).toHaveLength(24);
  expect(ui.captureCharFrame()).toBe(before);
});

test("the view lays out against its own box inside a larger terminal", async () => {
  const ui = await mount(
    <box height={24} width={100}>
      {view(threads.done).node}
    </box>,
    { height: 40, width: 140 }
  );
  await type(ui, "explain this example");
  await press(ui, "RETURN");
  const lines = (await frameWith(ui, "bun run start")).split("\n");

  expect(lines.slice(24).join("").trim()).toBe("");
  expect(Math.max(...lines.map((line) => line.trimEnd().length))).toBe(100);
  expect(lines.join("\n")).toContain("3/3 · ");
});
