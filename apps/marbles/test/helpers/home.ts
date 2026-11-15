import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { onTestFinished } from "vitest";
import { type Layout, layout } from "~/layout";
import { stopProcess } from "~/process/client";
import { SPAWN_RECORD_ENV } from "~/process/spawned";
import { recordProcess, stopRecorded, unrecordedMarked } from "./processes";
import { configureProviders } from "./providers";
import { outlast, RUN_ENV, runRecords } from "./runs";

/**
 * A Foundry home of the current test's own. Everything the test starts
 * gets it through `env`, which names the home in `FOUNDRY_HOME` and a
 * directory of its own in `MARBLES_SPAWN_RECORD`, where Marbles records
 * the daemon, engine generations and MCP servers it starts in the background. What
 * the test starts itself, and that outlives the call that started it, it
 * records with `track` in the same turn as the spawn.
 *
 * When the test finishes, the Marbles process there is asked to stop;
 * then what the records name is stopped, each proved again before every
 * signal (see `stopRecorded`), and the home is removed. A recorded
 * process that would not stop or cannot be proved, or a process that
 * carries the home without a record, fails the test and keeps the home.
 */
export interface TestHome {
  /** The environment for every process the test starts in this home. */
  readonly env: Record<string, string>;
  /** Where Marbles keeps things in this home. */
  readonly layout: Layout;
  /** The home itself. */
  readonly path: string;
  /**
   * Record `pid`, which the test has just started with `env`; `group`
   * when it leads a process group of its own (spawned detached, or on a
   * terminal). Call it in the same turn as the spawn.
   */
  track(pid: number | undefined, group: boolean): void;
}

export interface TestHomeOptions {
  /**
   * Configure the CLI providers, as a machine that has been set up is;
   * the default. `false` leaves the home as a first run finds it.
   */
  readonly providers?: boolean;
}

/** How long the Marbles process gets to stop when asked, before it is signalled. */
const STOP_ASKED_MS = 10_000;
/** Asking, then the signals' grace and kill periods, with room to spare. */
const TEARDOWN_MS = STOP_ASKED_MS + 20_000;

/** A fresh home under the run's root, torn down when the current test finishes. */
export function testHome(options: TestHomeOptions = {}): TestHome {
  const root = process.env[RUN_ENV];
  if (root === undefined) {
    throw new Error("testHome() runs inside the suite's setup only");
  }
  // Short: the process socket sits in the home, under a path of 104 bytes.
  const path = mkdtempSync(join(tmpdir(), "h-"));
  const records = join(runRecords(root), basename(path));
  const home: TestHome = {
    env: {
      ...definedEnv(),
      FOUNDRY_HOME: path,
      [SPAWN_RECORD_ENV]: records,
    },
    layout: layout({ home: path }),
    path,
    track(pid, group) {
      if (pid !== undefined) {
        recordProcess(records, pid, group);
      }
    },
  };
  if (options.providers !== false) {
    configureProviders(home.layout.state);
  }
  onTestFinished(() => tearDown(home, root, records), TEARDOWN_MS);
  return home;
}

async function tearDown(
  home: TestHome,
  root: string,
  records: string
): Promise<void> {
  try {
    await stopProcess({ layout: home.layout, timeoutMs: STOP_ASKED_MS });
  } catch {
    // Not answering, or not stopping in time: it is signalled below.
  }
  const problems = await stopRecorded(records, {
    name: RUN_ENV,
    value: root,
  });
  const unrecorded = await outlast(() =>
    unrecordedMarked(records, { name: "FOUNDRY_HOME", value: home.path })
  );
  for (const pid of unrecorded) {
    problems.push(
      `process ${String(pid)} was started with FOUNDRY_HOME=${home.path} but never recorded; not signalled`
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `the processes of the test home ${home.path} are not all confirmed gone:\n  ${problems.join("\n  ")}`
    );
  }
  rmSync(home.path, { force: true, maxRetries: 3, recursive: true });
}

function definedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}
