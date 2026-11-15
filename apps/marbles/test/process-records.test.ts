/**
 * A stop of a run's processes removes a record only once it has proved
 * the process it names gone, and never one that names a process still
 * running, however the writes of a process that records another land
 * against its own. No process here is real: the system is made up, and
 * nothing is signalled.
 */

import {
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  forgetRecord,
  type ProcessSystem,
  type RecordFiles,
  stopRecorded,
} from "./helpers/processes";
import { temporaryDirectory } from "./helpers/temporary";

const MARKER = { name: "MARBLES_TEST_PROBE", value: "records" };
const PID = 4_200_042;
const OLD = { group: false, pid: PID, started: "Sun Nov 15 08:00:00 2026" };
const NEW = { ...OLD, started: "Sun Nov 15 09:00:00 2026" };
const NEWER = { ...OLD, started: "Sun Nov 15 10:00:00 2026" };

function put(path: string, record: typeof OLD): void {
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
}

/** The starts the records under `dir` name for `PID`. */
function startsIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")).started)
    .sort();
}

/** The real file operations, with `before` run ahead of each, counted. */
function hooked(before: (index: number) => void): RecordFiles {
  let index = 0;
  const step = <T>(work: () => T): T => {
    before(index);
    index += 1;
    return work();
  };
  return {
    link: (existing, path) => step(() => linkSync(existing, path)),
    read: (path) => step(() => readFileSync(path, "utf8")),
    remove: (path) => step(() => rmSync(path, { force: true })),
    rename: (from, to) => step(() => renameSync(from, to)),
  };
}

it("removes a record proved gone, and none that a process given its pid since wrote, wherever that write lands", () => {
  let tried = 0;
  for (let at = 0; ; at += 1) {
    const dir = temporaryDirectory("rec-");
    const path = join(dir, `${String(PID)}.json`);
    put(path, OLD);
    let landed = false;
    forgetRecord(
      { ...OLD, path },
      hooked((index) => {
        if (index === at) {
          // A process given the pid since records itself.
          put(path, NEW);
          landed = true;
        }
      })
    );
    if (!landed) {
      break;
    }
    tried += 1;
    expect({ at, starts: startsIn(dir) }).toEqual({
      at,
      starts: [NEW.started],
    });
  }
  // Before the move, before the read, and before the removal.
  expect(tried).toBe(3);

  // Undisturbed, the record proved gone goes, and nothing else is left.
  const dir = temporaryDirectory("rec-");
  put(join(dir, `${String(PID)}.json`), OLD);
  forgetRecord({ ...OLD, path: join(dir, `${String(PID)}.json`) });
  expect(readdirSync(dir)).toEqual([]);
});

it("puts back a record it moved that names another process, never over a newer one", () => {
  for (const second of [false, true]) {
    const dir = temporaryDirectory("rec-");
    const path = join(dir, `${String(PID)}.json`);
    // Replaced before the stop came to remove it.
    put(path, NEW);
    forgetRecord(
      { ...OLD, path },
      hooked((index) => {
        // Moved aside and read (0, 1); then a newer one takes the path.
        if (second && index === 2) {
          put(path, NEWER);
        }
      })
    );
    expect(startsIn(dir)).toEqual(
      second ? [NEW.started, NEWER.started] : [NEW.started]
    );
    expect(JSON.parse(readFileSync(path, "utf8")).started).toBe(
      second ? NEWER.started : NEW.started
    );
  }
});

it("keeps, and reports, a record written during the stop for a process it cannot prove", async () => {
  const dir = temporaryDirectory("rec-");
  const path = join(dir, `${String(PID)}.json`);
  put(path, OLD);
  let looks = 0;
  const system: ProcessSystem = {
    // Its environment cannot be read: matched, never proved, never signalled.
    environment: () => (looks > 1 ? undefined : []),
    kill: () => {
      throw new Error("nothing here may be signalled");
    },
    look: (pids) => {
      looks += 1;
      if (looks === 2) {
        // OLD was found gone; a process given its pid records itself.
        put(path, NEW);
      }
      return new Map(
        looks > 1 && pids.includes(PID)
          ? [[PID, { pgid: 1, started: NEW.started }]]
          : []
      );
    },
    members: () => [],
    sleep: () => Promise.resolve(),
  };
  const problems = await stopRecorded(
    dir,
    MARKER,
    { graceMs: 0, killMs: 0 },
    system
  );
  expect(problems).toEqual([
    expect.stringContaining("could not be proved; not signalled"),
  ]);
  expect(existsSync(path)).toBe(true);
  expect(startsIn(dir)).toEqual([NEW.started]);
});
