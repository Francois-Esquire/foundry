import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "@foundry/lib/node/process-identity";
import { expect, onTestFinished, vi } from "vitest";
import type { Layout } from "~/layout";
import type { WorkspaceSummary } from "~/model/connection";
import { connect, type MarblesClient } from "~/process/client";
import { type Daemon, type DaemonOptions, startDaemon } from "~/process/daemon";
import { testHome } from "./home";

export interface GenerationFiles {
  readonly gates: string;
  readonly log: string;
  readonly machine: Layout;
  readonly root: string;
  readonly source: string;
}

interface SwitchFixture extends GenerationFiles {
  readonly client: MarblesClient;
  readonly daemon: Daemon;
  readonly summary: WorkspaceSummary;
}

function moduleText(
  fixture: Pick<SwitchFixture, "gates" | "log">,
  revision: number
): string {
  const holds = [1, 2]
    .map(
      (n) =>
        `export const hold${String(n)} = step("hold${String(n)}").do(async () => {
  note("hold${String(n)}");
  while (!existsSync(${JSON.stringify(join(fixture.gates, String(n)))})) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return process.pid;
});`
    )
    .join("\n");
  return [
    'import { appendFileSync, existsSync } from "node:fs";',
    "export default { pools: { default: 1 } };",
    'import { step } from "@foundry.sh/marbles";',
    `const note = (what) => appendFileSync(${JSON.stringify(fixture.log)}, what + " " + process.pid + "\\n");`,
    holds,
    `export const asking = step("asking").do(async ({ ask }) => {
  note("asking");
  return await ask.question({ title: "Go on?", choices: ["yes", "no"] });
});`,
    `export const revision = ${String(revision)};`,
    "",
  ].join("\n");
}

export function generationFiles(
  home: ReturnType<typeof testHome>
): GenerationFiles {
  const root = join(home.path, "project");
  mkdirSync(root);
  const gates = join(home.path, "gates");
  mkdirSync(gates);
  const log = join(home.path, "steps.log");
  writeFileSync(log, "");
  return {
    gates,
    log,
    machine: home.layout,
    root,
    source: join(root, "marbles.config.ts"),
  };
}

export async function startSwitchingWorkspace(
  fixture: GenerationFiles,
  text: string,
  options: Partial<DaemonOptions> = {},
  track?: (daemon: Daemon) => void
): Promise<SwitchFixture> {
  writeFileSync(fixture.source, text);
  const daemon = await startDaemon({
    layout: fixture.machine,
    print: () => undefined,
    ...options,
  });
  if (track === undefined) {
    onTestFinished(() => daemon.close(), 60_000);
  } else {
    track(daemon);
  }
  const client = await connect({ layout: fixture.machine, start: false });
  onTestFinished(() => client.close());
  const summary = await client.attach(fixture.source);
  return { ...fixture, client, daemon, summary };
}

export function switchingWorkspace(
  options: {
    readonly daemon?: Partial<DaemonOptions>;
    readonly providers?: boolean;
  } = {}
): Promise<SwitchFixture> {
  const fixture = generationFiles(
    testHome({ providers: options.providers ?? false })
  );
  return startSwitchingWorkspace(
    fixture,
    moduleText(fixture, 0),
    options.daemon
  );
}

export function logged(fixture: Pick<GenerationFiles, "log">): string[] {
  return readFileSync(fixture.log, "utf8").split("\n").filter(Boolean);
}

export async function whenLogged(
  fixture: Pick<SwitchFixture, "log">,
  line: string
): Promise<void> {
  await vi.waitFor(() => expect(logged(fixture)).toContain(line), {
    interval: 50,
    timeout: 30_000,
  });
}

export async function switchFrom(
  fixture: GenerationFiles & { readonly client: MarblesClient },
  before: number,
  revision: number,
  text = moduleText(fixture, revision)
): Promise<number> {
  writeFileSync(fixture.source, text);
  let pid = before;
  await vi.waitFor(
    async () => {
      const [summary] = await fixture.client.workspaces();
      expect(summary?.state).toBe("ready");
      expect(summary?.pid).not.toBe(before);
      pid = summary?.pid ?? before;
    },
    { interval: 100, timeout: 60_000 }
  );
  return pid;
}

export function openGate(
  gate: number | string,
  fixture: Pick<SwitchFixture, "gates">
): void {
  writeFileSync(join(fixture.gates, String(gate)), "");
}

export async function gone(pid: number, timeout = 30_000): Promise<void> {
  await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
    interval: 100,
    timeout,
  });
}
