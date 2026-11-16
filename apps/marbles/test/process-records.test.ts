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
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  forgetRecord,
  type ProcessSystem,
  type RecordFiles,
  stopRecorded,
} from "./helpers/processes";
import { type RootFiles, removeRoot, sweepFinishedRuns } from "./helpers/runs";
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
    // A signal reaches a process just when it is listed.
    alive: (pid) => looks > 1 && pid === PID,
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

/** Every record file under `dir`, at any depth, with the start it names. */
function recordsUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter(
      (entry) => entry.name !== "owner.json" && entry.name !== "moved-from.json"
    )
    .map(
      (entry) =>
        JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8"))
          .started
    );
}

it("never removes a run's root with a record in it, wherever that record lands against the removal", async () => {
  let tried = 0;
  for (let at = 0; ; at += 1) {
    const parent = temporaryDirectory("sw-");
    const root = join(parent, "marbles-run-made-up");
    mkdirSync(join(root, "spawned"), { mode: 0o700, recursive: true });
    put(join(root, "owner.json"), { ...OLD, group: false });
    let landed = false;
    // The process records itself through the root's own path, as one
    // whose environment names it does; it is never proved, so never
    // signalled.
    const lands = () => {
      mkdirSync(join(root, "spawned", "late"), {
        mode: 0o700,
        recursive: true,
      });
      put(join(root, "spawned", "late", `${String(PID)}.json`), NEW);
      landed = true;
    };
    const files: RootFiles = {
      remove: (path) => {
        if (at === 1) {
          lands();
        }
        rmSync(path, { force: true, recursive: true });
      },
      rename: (from, to) => {
        if (at === 0) {
          lands();
        }
        renameSync(from, to);
      },
    };
    const system: ProcessSystem = {
      alive: (pid) => landed && pid === PID,
      environment: () => undefined,
      kill: () => {
        throw new Error("nothing here may be signalled");
      },
      look: (pids) =>
        new Map(
          landed && pids.includes(PID)
            ? [[PID, { pgid: 1, started: NEW.started }]]
            : []
        ),
      members: () => [],
      sleep: () => Promise.resolve(),
    };
    const kept = await removeRoot(root, {
      files,
      limits: { graceMs: 0, killMs: 0 },
      system,
    });
    if (!landed) {
      break;
    }
    tried += 1;
    expect({ at, records: recordsUnder(parent) }).toEqual({
      at,
      records: [NEW.started],
    });
    expect(kept).not.toEqual([]);
  }
  // Before the move aside, and after it, through the old path.
  expect(tried).toBe(2);
});

it("removes a run's root that holds no record, and nothing else", async () => {
  const parent = temporaryDirectory("sw-");
  const root = join(parent, "marbles-run-made-up");
  mkdirSync(join(root, "spawned", "home"), { mode: 0o700, recursive: true });
  put(join(root, "owner.json"), { ...OLD, group: false });
  expect(await removeRoot(root)).toEqual([]);
  expect(readdirSync(parent)).toEqual([]);
});

it("forgets a record only on proof its process is gone: never for one unlisted that a signal reaches, nor one of a start it cannot compare", async () => {
  const stop = (system: Partial<ProcessSystem>) =>
    stopRecorded(
      dir,
      MARKER,
      { graceMs: 0, killMs: 0 },
      {
        alive: () => false,
        environment: () => [`${MARKER.name}=${MARKER.value}`],
        kill: () => {
          throw new Error("nothing here may be signalled");
        },
        look: () => new Map(),
        members: () => [],
        sleep: () => Promise.resolve(),
        ...system,
      }
    );
  const dir = temporaryDirectory("rec-");
  const path = join(dir, `${String(PID)}.json`);

  // Not listed, yet a signal reaches it: cannot tell.
  put(path, OLD);
  expect(await stop({ alive: (pid) => pid === PID })).toEqual([
    expect.stringContaining("is not listed but a signal still reaches it"),
  ]);
  expect(existsSync(path)).toBe(true);

  // A start of a kind this system cannot compare: cannot tell.
  put(path, { ...OLD, started: `ps:${OLD.started}` });
  expect(
    await stop({
      alive: () => true,
      look: () => new Map([[PID, { pgid: 1, started: OLD.started }]]),
    })
  ).toEqual([expect.stringContaining("a start of a kind this system cannot")]);
  expect(existsSync(path)).toBe(true);

  // Listed as exited and unreaped, a signal still reaching it: gone.
  put(path, OLD);
  expect(
    await stop({
      alive: () => true,
      look: () =>
        new Map([[PID, { exited: true, pgid: 1, started: OLD.started }]]),
    })
  ).toEqual([]);
  expect(existsSync(dir)).toBe(false);
});

/** A run root under `parent`, recording `record`, with an owner unless `owner` is false. */
function runRoot(
  parent: string,
  name: string,
  record: typeof OLD,
  owner = true
): string {
  const root = join(parent, name);
  mkdirSync(join(root, "spawned", "late"), { mode: 0o700, recursive: true });
  put(join(root, "spawned", "late", `${String(record.pid)}.json`), record);
  if (owner) {
    put(join(root, "owner.json"), { ...OLD, pid: 4_200_399 });
  }
  return root;
}

it("restores the owner of a root made again, and reports, when the process lookup fails mid-removal", async () => {
  const parent = temporaryDirectory("sw-");
  // A record the stop of the moved root has to look its process up for.
  const root = runRoot(parent, "marbles-run-lookup-fails", OLD);
  const files: RootFiles = {
    remove: (path) => rmSync(path, { force: true, recursive: true }),
    rename: (from, to) => {
      renameSync(from, to);
      // A process records itself through the old path right after.
      mkdirSync(join(root, "spawned"), { mode: 0o700, recursive: true });
      put(join(root, "spawned", `${String(PID)}.json`), NEW);
    },
  };
  const kept = await removeRoot(root, {
    files,
    limits: { graceMs: 0, killMs: 0 },
    system: {
      alive: () => {
        throw new Error("the process lookup failed");
      },
      environment: () => {
        throw new Error("the process lookup failed");
      },
      kill: () => {
        throw new Error("nothing here may be signalled");
      },
      look: () => {
        throw new Error("the process lookup failed");
      },
      members: () => [],
      sleep: () => Promise.resolve(),
    },
  });
  expect(kept).toEqual(
    expect.arrayContaining([
      expect.stringContaining("the process lookup failed"),
    ])
  );
  expect(existsSync(join(root, "owner.json"))).toBe(true);
  expect(existsSync(join(root, "spawned", `${String(PID)}.json`))).toBe(true);
});

it("never passes over a run root that holds records and names no owner: its records are handled as any run's", async () => {
  const parent = temporaryDirectory("sw-");
  const system: ProcessSystem = {
    alive: (pid) => pid === NEWER.pid + 1,
    environment: () => undefined,
    kill: () => {
      throw new Error("nothing here may be signalled");
    },
    look: () => new Map(),
    members: () => [],
    sleep: () => Promise.resolve(),
  };
  // Its process is gone: the record is forgotten, the root removed.
  const gone = runRoot(parent, "marbles-run-ownerless-gone", OLD, false);
  // Its process is not listed but answers: kept, and reported.
  const answering = runRoot(
    parent,
    "marbles-run-ownerless-answering",
    { ...NEWER, pid: NEWER.pid + 1 },
    false
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let warned: string;
  try {
    await sweepFinishedRuns(parent, { graceMs: 0, killMs: 0 }, system);
  } finally {
    warned = warn.mock.calls.flat().join("\n");
    warn.mockRestore();
  }
  expect(existsSync(gone)).toBe(false);
  expect(existsSync(answering)).toBe(true);
  expect(warned).toContain("is not listed but a signal still reaches it");
  // A root being made, with neither owner nor record yet, is left alone.
  const making = join(parent, "marbles-run-making");
  mkdirSync(making, { mode: 0o700 });
  await sweepFinishedRuns(parent, { graceMs: 0, killMs: 0 }, system);
  expect(existsSync(making)).toBe(true);
});
