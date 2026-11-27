import { resolve } from "node:path";
import { resolveWorkspaceTarget } from "~/cli/resource-runner";
import type { Triggers } from "~/create";
import { type Layout, layout as resolveLayout } from "~/layout";
import type { Hosted, TaskRunner } from "~/process/access";
import { attachToProcess, withTasks } from "~/process/access";
import type { HostOptions, OpenedWorkspace } from "~/workspace/open";
import {
  findWorkspace,
  hostTriggers,
  openWorkspace,
  recordedWorkspace,
} from "~/workspace/open";

export interface GlobalFlags extends HostOptions {
  readonly directory: string;
  readonly dry: false;
  readonly json: boolean;
  readonly sourceExplicit?: boolean;
}

export interface CliIo {
  readonly diagnose: (line: string) => void;
  readonly print: (line: string) => void;
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

export interface CliContext {
  readonly argv: readonly string[];
  attachWorkspace(run: (hosted: Hosted) => Promise<void>): Promise<void>;
  readonly entry?: string;
  findWorkspace(): OpenedWorkspace;
  readonly flags: GlobalFlags;
  readonly interactive: boolean;
  readonly io: CliIo;
  readonly layout: Layout;
  openTasks(
    run: (tasks: TaskRunner) => Promise<void>,
    workspace?: string
  ): Promise<void>;
  openTriggers(): Promise<{
    readonly opened: OpenedWorkspace;
    readonly triggers: Triggers;
  }>;
  output<T>(data: T, render: (value: T) => string): void;
}

export interface CliContextOptions {
  readonly argv: readonly string[];
  readonly entry?: string;
  readonly flags: GlobalFlags;
  readonly interactive?: boolean;
  readonly io?: CliIo;
  readonly layout?: Layout;
}

export function defaultCliIo(): CliIo {
  return {
    diagnose(line: string) {
      process.stderr.write(`${line}\n`);
    },
    print(line: string) {
      process.stdout.write(`${line}\n`);
    },
    stderr(text: string) {
      process.stderr.write(text);
    },
    stdout(text: string) {
      process.stdout.write(text);
    },
  };
}

async function printErrors(
  automations: Triggers["automations"],
  print: (line: string) => void
): Promise<void> {
  for (const [id, error] of Object.entries(await automations.errors())) {
    print(`[automation] ${id}: ${error}`);
  }
}

async function openedForTasks(
  flags: GlobalFlags,
  workspace?: string
): Promise<OpenedWorkspace> {
  if (workspace === undefined) {
    return findWorkspace(flags);
  }
  const target = await resolveWorkspaceTarget(
    resolve(flags.state),
    flags.directory,
    workspace
  );
  const recorded = await recordedWorkspace(flags, target.id);
  if (recorded !== undefined) {
    return recorded;
  }
  return findWorkspace({ ...flags, directory: target.root });
}

export function createCliContext(options: CliContextOptions): CliContext {
  const io = options.io ?? defaultCliIo();
  const { flags } = options;
  const interactive =
    options.interactive ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const resolvedLayout = options.layout ?? resolveLayout();
  return {
    argv: options.argv,
    attachWorkspace: (run) => attachToProcess(flags, run),
    ...(options.entry === undefined ? {} : { entry: options.entry }),
    findWorkspace: () => findWorkspace(flags),
    flags,
    interactive,
    io,
    layout: resolvedLayout,
    openTasks: async (run, workspace) =>
      withTasks(flags, await openedForTasks(flags, workspace), run),
    async openTriggers() {
      const log = flags.json ? io.diagnose : io.print;
      const opened = await openWorkspace(flags, { print: log });
      const triggers = hostTriggers(flags, opened);
      await printErrors(triggers.automations, log);
      return { opened, triggers };
    },
    output<T>(data: T, render: (value: T) => string): void {
      if (flags.json) {
        io.print(JSON.stringify(data, null, 2));
        return;
      }
      const text = render(data);
      if (text.length > 0) {
        io.print(text);
      }
    },
  };
}
