/**
 * The state machine the provider watcher keeps per read of the store
 * (`lib/providers/store-reads.ts`): every state against every event.
 */

import { describe, expect, it } from "vitest";
import type { ReadEvent, ReadState } from "~/lib/providers/store-reads";
import {
  FINE,
  nextRead,
  RECOVERED,
  retried,
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

/** [from, event, to, reported] for every state against every event. */
const TRANSITIONS: readonly [
  string,
  ReadState,
  ReadEvent,
  ReadState,
  string | undefined,
][] = [
  ["fine, succeeded", FINE, succeeded, FINE, undefined],
  ["fine, unreachable", FINE, failed("busy"), unreachable("busy"), "busy"],
  [
    "fine, invalid",
    FINE,
    found("bad key", 3),
    invalid("bad key", 3),
    "bad key",
  ],
  ["fine, not needed", FINE, notNeeded, FINE, undefined],
  ["unreachable, succeeded", unreachable("busy"), succeeded, FINE, RECOVERED],
  [
    "unreachable, unreachable with the same reason",
    unreachable("busy"),
    failed("busy"),
    unreachable("busy"),
    undefined,
  ],
  [
    "unreachable, unreachable with another reason",
    unreachable("busy"),
    failed("still busy"),
    unreachable("still busy"),
    "still busy",
  ],
  [
    "unreachable, invalid",
    unreachable("busy"),
    found("bad key", 3),
    invalid("bad key", 3),
    "bad key",
  ],
  ["unreachable, not needed", unreachable("busy"), notNeeded, FINE, undefined],
  ["invalid, succeeded", invalid("bad key", 3), succeeded, FINE, undefined],
  [
    "invalid, unreachable",
    invalid("bad key", 3),
    failed("busy"),
    unreachable("busy"),
    "busy",
  ],
  [
    "invalid, invalid again at the same revision",
    invalid("bad key", 3),
    found("bad key", 3),
    invalid("bad key", 3),
    undefined,
  ],
  [
    "invalid, invalid at a new revision",
    invalid("bad key", 3),
    found("bad key", 4),
    invalid("bad key", 4),
    "bad key",
  ],
  [
    "invalid, invalid for another reason",
    invalid("bad key", 3),
    found("no key at all", 3),
    invalid("no key at all", 3),
    "no key at all",
  ],
  ["invalid, not needed", invalid("bad key", 3), notNeeded, FINE, undefined],
];

describe("a read of the provider store", () => {
  it.each(TRANSITIONS)("%s", (_, from, event, to, reported) => {
    const { report, state } = nextRead(from, event);
    expect(state).toEqual(to);
    expect(report).toBe(reported);
  });

  it("is tried again on every poll only while it cannot reach the store", () => {
    expect(retried(FINE)).toBe(false);
    expect(retried(unreachable("busy"))).toBe(true);
    expect(retried(invalid("bad key", 3))).toBe(false);
  });
});
