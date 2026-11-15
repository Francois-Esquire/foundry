import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { type Layout, layout } from "~/layout";
import { stopProcess } from "~/process/client";
import { markedProcesses, stopProcesses } from "./processes";
import { configureProviders } from "./providers";

/**
 * A Foundry home of the current test's own. Everything the test starts
 * gets it through `FOUNDRY_HOME` in `env`, which is also the proof that a
 * process is the test's. When the test finishes, the Marbles process
 * there is asked to stop, then whatever still carries the home is
 * stopped, SIGTERM and then SIGKILL, with the process group it leads, and
 * the home is removed. A process that would not stop fails the test.
 */
export interface TestHome {
  /** `process.env` with `FOUNDRY_HOME` naming this home; give it to every process the test starts. */
  readonly env: Record<string, string>;
  /** Where Marbles keeps things in this home. */
  readonly layout: Layout;
  /** The home itself. */
  readonly path: string;
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
const TEARDOWN_MS = STOP_ASKED_MS + 15_000;

/** A fresh home under the run's root, torn down when the current test finishes. */
export function testHome(options: TestHomeOptions = {}): TestHome {
  // Short: the process socket sits in the home, under a path of 104 bytes.
  const path = mkdtempSync(join(tmpdir(), "h-"));
  const home: TestHome = {
    env: { ...definedEnv(), FOUNDRY_HOME: path },
    layout: layout({ home: path }),
    path,
  };
  if (options.providers !== false) {
    configureProviders(home.layout.state);
  }
  onTestFinished(() => tearDown(home), TEARDOWN_MS);
  return home;
}

async function tearDown(home: TestHome): Promise<void> {
  try {
    await stopProcess({ layout: home.layout, timeoutMs: STOP_ASKED_MS });
  } catch {
    // Not answering, or not stopping in time: it is signalled below.
  }
  const survivors = await stopProcesses(
    markedProcesses("FOUNDRY_HOME", home.path)
  );
  if (survivors.length > 0) {
    throw new Error(
      `processes started with FOUNDRY_HOME=${home.path} would not stop: ${survivors.join(", ")}`
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
