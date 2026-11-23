import { afterEach, describe, expect, test } from "vitest";
import { Portrait } from "../src/components/blocks/portrait";
import { HudLayout, hudGeometry } from "../src/components/layouts/hud";
import type { Progress } from "../src/game/progress";
import type { Scorecard } from "../src/game/scorecard";
import { type Rail, startRail } from "../src/model/rail";
import type { Size } from "../src/model/screen";
import type { Thread } from "../src/model/thread";
import {
  clock,
  context,
  progress,
  scorecards,
  threads,
} from "../stories/fixtures/threads";
import { frameWith, mount, unmount } from "./helpers/render";

const TALL = { height: 44, width: 120 };
const WHITESPACE = /\s+/g;

const ignore = () => undefined;

function layout(
  thread: Thread,
  {
    draft = "",
    levels = progress.fresh,
    rail = {},
    results = null,
    size = TALL,
  }: {
    draft?: string;
    levels?: Progress;
    rail?: Partial<Rail>;
    results?: Scorecard | null;
    size?: Size;
  } = {}
) {
  return mount(
    <HudLayout
      avatar="Smith"
      clock={clock}
      context={context}
      draft={draft}
      onDraft={ignore}
      onResize={ignore}
      onSubmit={ignore}
      portrait={<Portrait image={null} size={hudGeometry(size).portrait} />}
      progress={levels}
      rail={{ ...startRail(context), ...rail }}
      results={results}
      size={size}
      thread={thread}
    />,
    size
  );
}

afterEach(unmount);

test("an idle thread invites a goal and shows a fresh, unused rail", async () => {
  const frame = (await layout(threads.idle)).captureCharFrame();

  expect(frame).toContain("Give the harness a goal. It will:");
  expect(frame).toContain("No to-dos yet.");
  expect(frame).toContain("FOUNDRY AGENT HARNESS");
  expect(frame).toContain("0/0 · New thread");
  expect(frame).toContain("SMITH");
  expect(frame).toContain("fresh");
  expect(frame).toContain("❝ ready when you are ❞");
  expect(frame).toContain("200k / 200k");
  expect(frame).toContain("0 in · 0 out");
  expect(frame).toContain("No tools fired yet.");
  expect(frame).toContain("Give the harness a goal");
});

test("a draft shows in the goal field", async () => {
  const frame = (
    await layout(threads.idle, { draft: "list the files" })
  ).captureCharFrame();

  expect(frame).toContain("› list the files");
});

test("a planning thread says so in the steps and the goal field", async () => {
  const frame = (await layout(threads.planning)).captureCharFrame();

  expect(frame).toContain("⠸ Planning the goal into to-dos");
  expect(frame).toContain("Working. The next goal can go in");
  expect(frame).toContain("❝ sizing it up ❞");
});

test("a working thread shows its steps, tool calls, tallies and health", async () => {
  const frame = (await layout(threads.working)).captureCharFrame();

  expect(frame).toContain("✓ 1");
  expect(frame).toContain("⠸ 2 Identify the scripts and what each one runs");
  expect(frame).toContain("○ 3");
  expect(frame).toContain("✚ 4");
  expect(frame).toContain("1/4 · Read package.json");
  expect(frame).toContain("Task 1 · Read package.json in this directory");
  expect(frame).toContain("Task 2 · Identify the scripts");
  expect(frame).toContain("⠸ Bash (4.2s) bun run --help");
  expect(frame).toContain("scuffed");
  expect(frame).toContain("138k / 200k");
  expect(frame).toContain("3 calls");
  expect(frame).toContain("⠸ Bash");
});

test("a failed thread shows the tool's error and why the harness stopped", async () => {
  const frame = await frameWith(
    await layout(threads.failed),
    "Claude Code stopped before the turn finished."
  );

  expect(frame).toContain("✗ 1");
  expect(frame).toContain("File does not exist.");
  expect(frame).toContain("The harness stopped");
  expect(frame).toContain("❝ that one got away ❞");
  expect(frame).toContain("✗ Read");
});

test("a finished thread says what it kept", async () => {
  const frame = (await layout(threads.done)).captureCharFrame();

  expect(frame).toContain("◆ notes 3f9a1c2e · 1 kept");
  expect(frame).toContain("18.4k in · 912 out");
  expect(frame).toContain("3/3 · ");
});

test("the vitals show the level and the XP toward the next one", async () => {
  const fresh = (await layout(threads.idle)).captureCharFrame();
  expect(fresh).toContain("LV 1");
  expect(fresh).toContain("0/100 xp");

  const seasoned = (
    await layout(threads.done, { levels: progress.seasoned })
  ).captureCharFrame();
  expect(seasoned).toContain("LV 4");
  expect(seasoned).toContain("100/400 xp");
});

test("a finished, unjudged encounter shows its facts and the verdict keys", async () => {
  const frame = (
    await layout(threads.done, { results: scorecards.pending })
  ).captureCharFrame();

  expect(frame).toContain("RESULTS");
  expect(frame).toContain("awaiting verdict");
  expect(frame).toContain("3/3 steps · 2 calls, 0 failed · 19.3k tokens");
  expect(frame).toContain("97% left · sonnet/medium · 42s");
  expect(frame).toContain("Rank ?");
  expect(frame).toContain("A  Accept");
  expect(frame).toContain("R  Reject");
  expect(frame).not.toContain("PgUp/PgDn");
});

test("an accepted encounter shows its rank, line items and total", async () => {
  const frame = (
    await layout(threads.done, { results: scorecards.accepted })
  ).captureCharFrame();

  expect(frame).toContain("RANK S · +175 XP");
  expect(frame).toContain("Accepted +50");
  expect(frame).toContain("Steps done +30");
  expect(frame).toContain("Clean run +25");
  expect(frame).not.toContain("A  Accept");
  expect(frame).toContain("PgUp/PgDn");
});

test("a rejected encounter banks nothing", async () => {
  const frame = (
    await layout(threads.done, { results: scorecards.rejected })
  ).captureCharFrame();

  expect(frame).toContain("RANK C · +0 XP");
  expect(frame).toContain("Rejected · nothing banked");
});

test("the verdict keys fit the hint bar at 80 and 60 columns", async () => {
  for (const size of [
    { height: 24, width: 80 },
    { height: 24, width: 60 },
  ]) {
    const frame = (
      await layout(threads.done, { results: scorecards.pending, size })
    ).captureCharFrame();
    const hints = frame.trimEnd().split("\n").at(-1) ?? "";
    expect(hints).toContain("A  Accept");
    expect(hints).toContain("^C  Quit");
    expect(frame).toContain("RESULTS");
  }
});

function mainText(frame: string, from: number): string {
  return frame
    .split("\n")
    .map((line) => line.slice(from).replaceAll("│", " "))
    .join(" ")
    .replace(WHITESPACE, " ");
}

test("a judged card keeps every line item, the cap first, at 80 and 60 columns", async () => {
  for (const [size, from] of [
    [{ height: 24, width: 80 }, 37],
    [{ height: 24, width: 60 }, 0],
  ] as const) {
    const accepted = mainText(
      (
        await layout(threads.done, { results: scorecards.accepted, size })
      ).captureCharFrame(),
      from
    );
    expect(accepted).toContain(
      "Accepted +50 · Steps done +30 · Clean run +25 · Light touch +20 · Lighter gun +15 · Less ammo +10 · Under par +25"
    );

    const consoled = mainText(
      (
        await layout(threads.failed, { results: scorecards.consoled, size })
      ).captureCharFrame(),
      from
    );
    expect(consoled).toContain("RANK C · +10 XP");
    expect(consoled).toContain(
      "Failed run \u2212110 · Accepted +50 · Light touch +20 · Lighter gun +15 · Less ammo +10 · Under par +25"
    );
  }
});

test("a pending card at 80 columns keeps every fact", async () => {
  const frame = (
    await layout(threads.done, {
      results: scorecards.pending,
      size: { height: 24, width: 80 },
    })
  ).captureCharFrame();

  expect(frame).toContain("3/3 steps");
  expect(frame).toContain("42s");
  expect(frame).toContain("R  Reject");
});

test("a short screen drops the results card and keeps the conversation", async () => {
  const frame = (
    await layout(threads.done, {
      results: scorecards.pending,
      size: { height: 16, width: 120 },
    })
  ).captureCharFrame();

  expect(frame).not.toContain("RESULTS");
  expect(frame).toContain("A  Accept");
});

test("the rail shows the gun, the ammo and the loadout", async () => {
  const frame = (await layout(threads.idle)).captureCharFrame();

  expect(frame).toContain("▶ GUN  SONNET");
  expect(frame).toContain("◂ 1/3 ▸");
  expect(frame).toContain("AMMO ▮▮▯");
  expect(frame).toContain("medium effort");
  expect(frame).toContain("01 task-notes");
  expect(frame).toContain("02 backlog");
  expect(frame).toContain("↑/↓  Gun");
});

test("the focused stop is marked and names itself in the hints", async () => {
  const ammo = (
    await layout(threads.idle, {
      rail: { effort: "high", focus: "effort", model: "opus" },
    })
  ).captureCharFrame();
  expect(ammo).toContain("GUN  OPUS");
  expect(ammo).toContain("▶ AMMO ▮▮▮");
  expect(ammo).toContain("↑/↓  Ammo");

  const slot = (
    await layout(threads.idle, { rail: { focus: "slot", slot: 1 } })
  ).captureCharFrame();
  expect(slot).toContain("▶ 02 backlog");
  expect(slot).toContain("The harness's own to-do list");
  expect(slot).toContain("↑/↓  Loadout");

  const avatar = (
    await layout(threads.idle, { rail: { focus: "avatar" } })
  ).captureCharFrame();
  expect(avatar).toContain("◂ ❝ ready when you are ❞ ▸");
  expect(avatar).toContain("↑/↓  Avatar");
});

test("an 80 by 24 screen keeps the portrait, vitals and weapon", async () => {
  const frame = (
    await layout(threads.working, { size: { height: 24, width: 80 } })
  ).captureCharFrame();

  expect(frame).toContain("SMITH");
  expect(frame).toContain("VITALS");
  expect(frame).toContain("WEAPON");
  expect(frame).not.toContain("LOADOUT");
  expect(frame).not.toContain("ARSENAL");
  expect(frame).toContain("⠸ 2 Identify");
  expect(frame.trimEnd().split("\n")).toHaveLength(24);
});

test("a narrow screen drops the rail and keeps the conversation", async () => {
  const frame = await frameWith(
    await layout(threads.done, { size: { height: 24, width: 60 } }),
    "bun run start"
  );

  expect(frame).not.toContain("VITALS");
  expect(frame).not.toContain("Tab");
  expect(frame.trimEnd().split("\n")).toHaveLength(24);
  expect(frame).toContain("PgUp/PgDn");
  expect(frame).toContain("FOUNDRY AGENT HARNESS");
});

describe("the geometry", () => {
  test.each([
    [
      { height: 44, width: 120 },
      "large",
      ["vitals", "weapon", "loadout", "arsenal"],
    ],
    [
      { height: 34, width: 120 },
      "small",
      ["vitals", "weapon", "loadout", "arsenal"],
    ],
    [{ height: 30, width: 96 }, "small", ["vitals", "weapon", "loadout"]],
    [{ height: 24, width: 80 }, "small", ["vitals", "weapon"]],
  ] as const)("at %o the portrait is %s", (size, portrait, sections) => {
    const geometry = hudGeometry(size);
    expect(geometry.rail).toBe(true);
    expect(geometry.results).toBe(false);
    expect(geometry.portrait).toBe(portrait);
    expect(geometry.sections).toEqual(sections);
  });

  test("the results card takes its rows from the page when it fits", () => {
    const tall = { height: 44, width: 120 };
    expect(hudGeometry(tall, true).results).toBe(true);
    expect(hudGeometry(tall).page - hudGeometry(tall, true).page).toBe(6);
    expect(hudGeometry({ height: 22, width: 120 }, true).results).toBe(true);
    expect(hudGeometry({ height: 21, width: 120 }, true).results).toBe(false);
    expect(hudGeometry({ height: 16, width: 120 }, true).page).toBe(
      hudGeometry({ height: 16, width: 120 }).page
    );
  });

  test("the stops follow what the rail shows", () => {
    expect(hudGeometry({ height: 44, width: 120 }).stops).toEqual([
      "avatar",
      "model",
      "effort",
      "slot",
    ]);
    expect(hudGeometry({ height: 24, width: 80 }).stops).toEqual([
      "avatar",
      "model",
      "effort",
    ]);
    expect(hudGeometry({ height: 24, width: 60 }).stops).toEqual([]);
    expect(hudGeometry({ height: 24, width: 60 }).rail).toBe(false);
  });
});
