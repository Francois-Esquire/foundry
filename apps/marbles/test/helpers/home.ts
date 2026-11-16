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

export interface TestHome {
  readonly env: Record<string, string>;
  readonly layout: Layout;
  readonly path: string;
  track(pid: number | undefined, group: boolean): void;
}

export interface TestHomeOptions {
  readonly providers?: boolean;
}

const STOP_ASKED_MS = 10_000;
const TEARDOWN_MS = STOP_ASKED_MS + 20_000;

export function testHome(options: TestHomeOptions = {}): TestHome {
  const root = process.env[RUN_ENV];
  if (root === undefined) {
    throw new Error("testHome() runs inside the suite's setup only");
  }
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
