import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "@foundry/lib/process-identity";
import { expect, onTestFinished, vi } from "vitest";
import type { Layout } from "~/layout";
import type { WorkspaceSummary } from "~/model/connection";
import { connect, type MarblesClient } from "~/process/client";
import { type DaemonOptions, startDaemon } from "~/process/daemon";
import { testHome } from "./home";

export interface SwitchFixture {
  readonly client: MarblesClient;
  readonly gates: string;
  readonly lines: readonly string[];
  readonly log: string;
  readonly machine: Layout;
  readonly source: string;
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

export async function switchingWorkspace(
  options: {
    readonly daemon?: Partial<DaemonOptions>;
    readonly providers?: boolean;
  } = {}
): Promise<SwitchFixture> {
  const home = testHome({ providers: options.providers ?? false });
  const root = join(home.path, "project");
  mkdirSync(root);
  const gates = join(home.path, "gates");
  mkdirSync(gates);
  const lines: string[] = [];
  const fixture = {
    gates,
    lines,
    log: join(home.path, "steps.log"),
    machine: home.layout,
    source: join(root, "marbles.config.ts"),
  };
  writeFileSync(fixture.log, "");
  writeFileSync(fixture.source, moduleText(fixture, 0));
  const daemon = await startDaemon({
    layout: fixture.machine,
    print: (line) => lines.push(line),
    ...options.daemon,
  });
  onTestFinished(() => daemon.close(), 60_000);
  const client = await connect({ layout: fixture.machine, start: false });
  onTestFinished(() => client.close());
  const summary = await client.attach(fixture.source);
  return { ...fixture, client, summary };
}

export async function whenLogged(
  fixture: Pick<SwitchFixture, "log">,
  line: string
): Promise<void> {
  await vi.waitFor(
    () =>
      expect(
        readFileSync(fixture.log, "utf8").split("\n").filter(Boolean)
      ).toContain(line),
    { interval: 50, timeout: 30_000 }
  );
}

export async function switchFrom(
  fixture: SwitchFixture,
  before: number,
  revision: number
): Promise<number> {
  writeFileSync(fixture.source, moduleText(fixture, revision));
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
  gate: number,
  fixture: Pick<SwitchFixture, "gates">
): void {
  writeFileSync(join(fixture.gates, String(gate)), "");
}

export async function gone(pid: number): Promise<void> {
  await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
    interval: 100,
    timeout: 30_000,
  });
}
