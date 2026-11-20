import { expect, test } from "vitest";
import { frameRows, hudGeometry, railPlan } from "../src/model/hud";

const size = { height: 12, width: 40 };
const RAIL = 20;

const sections = [
  { height: 2, key: "portrait" },
  { height: 1, key: "vitals", title: "VITALS" },
  { height: "fill" as const, key: "loadout", meta: "2", title: "LOADOUT" },
];

function drawn(height = size.height) {
  const plan = railPlan(sections, height);
  const frame = { height, width: size.width };
  return frameRows({
    goalRow: hudGeometry(frame, RAIL).goalRow,
    rail: RAIL,
    rules: plan.rules,
    size: frame,
    title: "A goal",
  }).map((row) => row.map((segment) => segment.text).join(""));
}

test("the rail stacks its sections under one-row rules and gives the rest to the filling one", () => {
  expect(railPlan(sections, size.height)).toEqual({
    rules: [
      { meta: undefined, row: 3, title: "VITALS" },
      { meta: "2", row: 5, title: "LOADOUT" },
    ],
    slots: [
      { height: 2, key: "portrait", top: 1 },
      { height: 1, key: "vitals", top: 4 },
      { height: 5, key: "loadout", top: 6 },
    ],
  });
});

test("the frame joins the rail, the conversation and the goal bar", () => {
  expect(drawn()).toEqual([
    "╔═══◆══════════◆═══╦══◆═ A goal ═══◆═══╗",
    "║                  ║                   ║",
    "║                  ║                   ║",
    "╟──◆ VITALS ───────╢                   ║",
    "║                  ║                   ║",
    "╟──◆ LOADOUT ── 2 ─╢                   ║",
    "║                  ║                   ║",
    "║                  ║                   ║",
    "║                  ║                   ║",
    "║                  ╠═══════════════════╣",
    "║                  ║                   ║",
    "╚═══◆══════════◆═══╩══◆════════════◆═══╝",
  ]);
});

test("a rule on the goal bar's row gets a four-way joint", () => {
  expect(drawn(8)[5]).toBe("╟──◆ LOADOUT ── 2 ─╬═══════════════════╣");
});

test("every row is exactly as wide as the frame", () => {
  expect(new Set(drawn().map((row) => row.length))).toEqual(
    new Set([size.width])
  );
});
