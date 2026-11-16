/**
 * The state machine the provider watcher keeps over the store's reads
 * (`lib/providers/store-reads.ts`): each read's transitions, what the
 * whole store reports for a move, and what is tried again on a poll.
 */

import { describe, expect, it } from "vitest";
import type {
  ReadEvent,
  ReadState,
  StoreRead,
  StoreReads,
} from "~/lib/providers/store-reads";
import {
  ALL_FINE,
  FINE,
  KEY_RECHECK_POLLS,
  moveReads,
  nextRead,
  RECOVERED,
  retriedOn,
} from "~/lib/providers/store-reads";

const unreachable = (message: string): ReadState => ({
  kind: "unreachable",
  message,
});
const invalid = (message: string, revision: number): ReadState => ({
  kind: "invalid",
  message,
  revision,
});
const succeeded: ReadEvent = { kind: "succeeded" };
const notNeeded: ReadEvent = { kind: "not needed" };
const failed = (message: string): ReadEvent => ({
  kind: "unreachable",
  message,
});
const found = (message: string, revision: number): ReadEvent => ({
  kind: "invalid",
  message,
  revision,
});
const reads = (changes: Partial<Record<StoreRead, ReadState>>): StoreReads => ({
  ...ALL_FINE,
  ...changes,
});

const STATES: readonly [string, ReadState][] = [
  ["fine", FINE],
  ["unreachable", unreachable("busy")],
  ["invalid", invalid("bad key", 3)],
];

describe("one read of the provider store", () => {
  /** Every state against every event: the event alone says where it goes. */
  it.each(
    STATES.flatMap(([name, from]) =>
      (
        [
          ["succeeded", succeeded, FINE],
          ["unreachable", failed("lock"), unreachable("lock")],
          ["invalid", found("no key", 4), invalid("no key", 4)],
          ["not needed", notNeeded, FINE],
        ] as const
      ).map(
        ([event, happened, to]) =>
          [`${name}, ${event}`, from, happened, to] as const
      )
    )
  )("%s", (_, from, event, to) => {
    expect(nextRead(from, event)).toEqual(to);
  });
});

/** [case, reads before, read, event, reported] */
const MOVES: readonly [
  string,
  StoreReads,
  StoreRead,
  ReadEvent,
  readonly string[],
][] = [
  ["all fine, a read succeeds", ALL_FINE, "configuration", succeeded, []],
  [
    "all fine, a read cannot reach the store",
    ALL_FINE,
    "identity key",
    failed("busy"),
    ["busy"],
  ],
  [
    "unreachable, the same read fails for the same reason",
    reads({ "identity key": unreachable("busy") }),
    "identity key",
    failed("busy"),
    [],
  ],
  [
    "unreachable, the same read fails for another reason",
    reads({ "identity key": unreachable("busy") }),
    "identity key",
    failed("still busy"),
    ["still busy"],
  ],
  [
    "unreachable, another read fails for the same reason",
    reads({ revision: unreachable("busy") }),
    "configuration",
    failed("busy"),
    [],
  ],
  [
    "unreachable, the read succeeds",
    reads({ "identity key": unreachable("busy") }),
    "identity key",
    succeeded,
    [RECOVERED],
  ],
  [
    "two unreachable, one succeeds: not yet recovered",
    reads({
      configuration: unreachable("busy"),
      revision: unreachable("busy"),
    }),
    "configuration",
    succeeded,
    [],
  ],
  [
    "the last unreachable read succeeds after another did: recovered once",
    reads({ revision: unreachable("busy") }),
    "revision",
    succeeded,
    [RECOVERED],
  ],
  [
    "the other read fails for another reason meanwhile",
    reads({
      configuration: unreachable("busy"),
      revision: unreachable("lock"),
    }),
    "configuration",
    succeeded,
    ["lock"],
  ],
  [
    "unreachable, no longer needed: no recovery",
    reads({ "identity key": unreachable("busy") }),
    "identity key",
    notNeeded,
    [],
  ],
  [
    "unreachable, then invalid content: reported, no recovery",
    reads({ "identity key": unreachable("busy") }),
    "identity key",
    found("bad key", 3),
    ["bad key"],
  ],
  [
    "invalid, the same content at the same revision",
    reads({ "identity key": invalid("bad key", 3) }),
    "identity key",
    found("bad key", 3),
    [],
  ],
  [
    "invalid, at a new revision",
    reads({ "identity key": invalid("bad key", 3) }),
    "identity key",
    found("bad key", 4),
    ["bad key"],
  ],
  [
    "invalid, for another reason",
    reads({ "identity key": invalid("bad key", 3) }),
    "identity key",
    found("no key at all", 3),
    ["no key at all"],
  ],
  [
    "invalid, repaired",
    reads({ "identity key": invalid("bad key", 3) }),
    "identity key",
    succeeded,
    [],
  ],
  [
    "invalid, then unreachable",
    reads({ "identity key": invalid("bad key", 3) }),
    "identity key",
    failed("busy"),
    ["busy"],
  ],
];

describe("what the provider store reports for a move", () => {
  it.each(MOVES)("%s", (_, before, read, event, reported) => {
    expect(moveReads(before, read, event).reports).toEqual(reported);
  });

  it("reports one recovery when the revision and another read both failed, whichever recovers first", () => {
    let state: StoreReads = ALL_FINE;
    const heard: string[] = [];
    const move = (read: StoreRead, event: ReadEvent) => {
      const moved = moveReads(state, read, event);
      state = moved.reads;
      heard.push(...moved.reports);
    };
    move("revision", failed("busy"));
    move("identity key", failed("busy"));
    // The key's retry goes first, while the revision is not read.
    move("identity key", succeeded);
    move("revision", succeeded);
    expect(heard).toEqual(["busy", RECOVERED]);
  });
});

describe("what a poll tries again", () => {
  it.each([
    ["configuration", FINE, 1, false],
    ["configuration", unreachable("busy"), 1, true],
    ["configuration", invalid("bad", 3), KEY_RECHECK_POLLS, false],
    ["identity key", FINE, KEY_RECHECK_POLLS, false],
    ["identity key", unreachable("busy"), 1, true],
    ["identity key", invalid("bad key", 3), 1, false],
    ["identity key", invalid("bad key", 3), KEY_RECHECK_POLLS, true],
    ["identity key", invalid("bad key", 3), 2 * KEY_RECHECK_POLLS, true],
    ["revision", unreachable("busy"), 1, true],
    ["revision", invalid("bad", 3), KEY_RECHECK_POLLS, false],
  ] as const)("%s, %o, poll %d: %s", (read, state, poll, retried) => {
    expect(retriedOn(read, state, poll)).toBe(retried);
  });
});
