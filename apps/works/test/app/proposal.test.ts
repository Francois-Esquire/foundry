import { expect, it } from "vitest";
import {
  applyFiles,
  holdAll,
  reconcileProposal,
  withConflicts,
} from "~/app/modules/proposal";

const TURN = "turn-1";

it("reconciles each file by the Draft, base and proposal values", () => {
  const draft = {
    agentOnly: "base",
    both: "draft",
    converged: "same",
    mineOnly: "mine",
    untouchedByAgent: "x",
  };
  const base = {
    agentOnly: "base",
    both: "base",
    converged: "base",
    mineOnly: "base",
  };
  const proposal = {
    agentOnly: "agent",
    both: "agent",
    converged: "same",
    mineOnly: "base",
  };
  const { changes, conflicts } = reconcileProposal(TURN, draft, base, proposal);
  // Draft == base → proposal; proposal == base → Draft; Draft == proposal → kept.
  expect(changes).toEqual({ agentOnly: "agent" });
  expect(conflicts).toEqual([
    {
      base: "base",
      draft: "draft",
      path: "both",
      proposal: "agent",
      turnId: TURN,
    },
  ]);
});

it("treats an absent file as a value on every side", () => {
  const base = {
    addedByAgent: null,
    addedByBoth: null,
    removedByAgent: "old",
    removedByMe: "old",
    removedVsEdited: "old",
  };
  const proposal = {
    addedByAgent: "new",
    addedByBoth: "theirs",
    removedByAgent: null,
    removedByMe: "edited",
    removedVsEdited: null,
  };
  const current = {
    addedByBoth: "mine",
    kept: "k",
    removedByAgent: "old",
    removedVsEdited: "edited by me",
  };
  const { changes, conflicts } = reconcileProposal(
    TURN,
    current,
    base,
    proposal
  );
  expect(changes).toEqual({ addedByAgent: "new", removedByAgent: null });
  expect(conflicts.map((conflict) => conflict.path).sort()).toEqual([
    "addedByBoth",
    "removedByMe",
    "removedVsEdited",
  ]);
  expect(
    conflicts.find((conflict) => conflict.path === "removedByMe")
  ).toMatchObject({ draft: null, proposal: "edited" });
  expect(applyFiles(current, changes)).toEqual({
    addedByAgent: "new",
    addedByBoth: "mine",
    kept: "k",
    removedVsEdited: "edited by me",
  });
});

it("accepts disjoint typing and conflicts overlapping edits", () => {
  const base = { "a.ts": "a", "b.ts": "b" };
  const proposal = { "b.ts": "b by agent" };
  const typedElsewhere = { "a.ts": "a typed", "b.ts": "b" };
  expect(
    reconcileProposal(TURN, typedElsewhere, { "b.ts": "b" }, proposal)
  ).toEqual({ changes: { "b.ts": "b by agent" }, conflicts: [] });
  const typedSameFile = { ...base, "b.ts": "b typed" };
  expect(
    reconcileProposal(TURN, typedSameFile, { "b.ts": "b" }, proposal).conflicts
  ).toHaveLength(1);
});

it("holds every file the proposal would change, for resolving by hand", () => {
  const files = {
    base: { "a.ts": "a", "b.ts": "b", "c.ts": null },
    proposal: { "a.ts": "a by agent", "b.ts": "b", "c.ts": "new" },
  };
  // b.ts already matches the proposal, so only a.ts and c.ts are held.
  const held = holdAll(TURN, { "a.ts": "a typed", "b.ts": "b" }, files);
  expect(held).toEqual([
    {
      base: "a",
      draft: "a typed",
      path: "a.ts",
      proposal: "a by agent",
      turnId: TURN,
    },
    { base: null, draft: null, path: "c.ts", proposal: "new", turnId: TURN },
  ]);
  // Holding them again replaces, never duplicates, that turn's conflicts.
  const other = { ...held[0], turnId: "turn-2" } as (typeof held)[number];
  expect(withConflicts([...held, other], held)).toEqual([other, ...held]);
});
