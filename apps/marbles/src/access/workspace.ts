import { layout } from "~/layout";
import { RecordsHeldError } from "~/lib/events/records";
import type { WorkspaceConnection } from "~/model/connection";
import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
} from "~/model/tasks";
import type { MarblesClient } from "~/process/client";
import { connect, NoProcessError } from "~/process/client";
import type { HostWorkspaceOptions, WorkspaceHost } from "~/workspace/host";
import { hostWorkspace } from "~/workspace/host";
import type { HostOptions, OpenedWorkspace } from "~/workspace/open";
import { hostTasks, workspaceEngine } from "~/workspace/open";
import { resolveSource } from "~/workspace/source";
import { runTaskCommand } from "~/workspace/tasks";

/**
 * How a command reaches its workspace, for the CLI and the MCP server
 * alike. There are three ways:
 *
 * - Stored state: an engine over the workspace's state that is never
 *   started, given up when the work is done. No source runs.
 * - A running instance: the worker of a Marbles process that already hosts
 *   the workspace, joined without starting anything.
 * - Start and host: attach the workspace to the Marbles process, starting
 *   one when none runs, or host it in this process under `--dry-run`. Only
 *   the CLI starts anything.
 */

/** Runs one task command on a workspace's own tasks; a refusal is a `TaskError`. */
export type TaskRunner = <K extends TaskCommandKind>(
  command: TaskCommand<K>
) => Promise<TaskCommandResult<K>>;

/** No running instance hosts the workspace a command needs one for. */
export class NotHostedError extends Error {
  override readonly name = "NotHostedError";
}

const ATTACH_HINT = "`marbles attach` in its root hosts it";

function machine(args: HostOptions) {
  return layout({ artifacts: args.artifacts, state: args.state });
}

/**
 * The workspace's tasks through an engine this process never starts, given
 * up when `work` ends. Under `--dry-run` they are in memory, and records
 * another process owns are refused, never answered from memory.
 */
async function withStoredTasks<T>(
  args: HostOptions,
  opened: OpenedWorkspace,
  print: (line: string) => void,
  work: (tasks: TaskRunner) => Promise<T>
): Promise<T> {
  const engine = workspaceEngine(args, opened, { print });
  try {
    const tasks = hostTasks(engine);
    return await work((command) => runTaskCommand(tasks, command));
  } finally {
    await engine.dispose();
  }
}

/** The running Marbles process, joined without starting one; undefined when none runs. */
export async function joinProcess(
  args: HostOptions
): Promise<MarblesClient | undefined> {
  try {
    return await connect({ layout: machine(args), start: false });
  } catch (error) {
    if (error instanceof NoProcessError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The worker that hosts the workspace now, when a Marbles process runs and
 * has it ready. Nothing is started or attached to find out. A worker that
 * is starting is about to own the tasks, so the command is refused rather
 * than racing it for them.
 */
async function hostingWorker(
  args: HostOptions,
  id: string
): Promise<
  | { readonly client: MarblesClient; readonly workspace: WorkspaceConnection }
  | undefined
> {
  const client = await joinProcess(args);
  if (client === undefined) {
    return undefined;
  }
  try {
    const summary = (await client.workspaces()).find(
      (entry) => entry.id === id
    );
    if (summary?.state === "ready") {
      return { client, workspace: client.workspace(summary) };
    }
    if (summary?.state === "starting" || summary?.state === "reloading") {
      throw new RecordsHeldError(
        `the tasks of this workspace are about to be in use by Marbles process pid ${String(client.hello.pid)}, whose worker is ${summary.state}; retry once it is ready`
      );
    }
  } catch (error) {
    client.close();
    throw error;
  }
  client.close();
  return undefined;
}

/**
 * The workspace's tasks, without running its source here or starting
 * anything that would. A worker that already hosts the workspace owns
 * them, so each command goes to it; otherwise they come from stored state.
 * `--dry-run` never asks a worker.
 */
export async function withTasks<T>(
  args: HostOptions,
  opened: OpenedWorkspace,
  print: (line: string) => void,
  work: (tasks: TaskRunner) => Promise<T>
): Promise<T> {
  const hosted = args.dry
    ? undefined
    : await hostingWorker(args, opened.workspace.id);
  if (hosted === undefined) {
    return withStoredTasks(args, opened, print, work);
  }
  try {
    return await work((command) => hosted.workspace.tasks(command));
  } finally {
    hosted.client.close();
  }
}

/**
 * Run `work` against the worker that hosts workspace `id` and has it ready.
 * Nothing is started or attached: without such a worker this rejects with a
 * `NotHostedError` that names the command that hosts it.
 */
export async function withRunningWorkspace<T>(
  args: HostOptions,
  id: string,
  work: (workspace: WorkspaceConnection) => Promise<T>
): Promise<T> {
  const client = await joinProcess(args);
  if (client === undefined) {
    throw new NotHostedError(
      `no Marbles process runs for ${machine(args).state}, so nothing hosts workspace ${id}; ${ATTACH_HINT}`
    );
  }
  try {
    const summary = (await client.workspaces()).find(
      (entry) => entry.id === id
    );
    if (summary === undefined) {
      throw new NotHostedError(
        `Marbles process pid ${String(client.hello.pid)} does not host workspace ${id}; ${ATTACH_HINT}`
      );
    }
    if (summary.state === "starting" || summary.state === "reloading") {
      throw new NotHostedError(
        `the worker for workspace ${id} is ${summary.state}; retry once it is ready`
      );
    }
    if (summary.state !== "ready") {
      throw new NotHostedError(
        `the worker for workspace ${id} is ${summary.state}${summary.error ? `: ${summary.error}` : ""}; ${ATTACH_HINT}`
      );
    }
    return await work(client.workspace(summary));
  } finally {
    client.close();
  }
}

/** A workspace hosted for a command: in this process, or by the Marbles process. */
export type Hosted =
  | { readonly kind: "local"; readonly host: WorkspaceHost }
  | {
      readonly kind: "remote";
      readonly client: MarblesClient;
      readonly id: string;
      readonly workspace: WorkspaceConnection;
    };

/** Host the workspace in this process; only `--dry-run` does. */
export function hostHere(
  args: HostOptions,
  options: Pick<HostWorkspaceOptions, "askable" | "env" | "print">
): Promise<WorkspaceHost> {
  return hostWorkspace({
    ...options,
    artifacts: args.artifacts,
    dry: args.dry,
    source: args.config,
    state: args.state,
  });
}

/** Attach the workspace to the Marbles process, starting one when none runs. */
export async function attachToProcess(
  args: HostOptions,
  run: (hosted: Hosted) => Promise<void>
): Promise<void> {
  const client = await connect({ layout: machine(args) });
  try {
    const summary = await client.attach(resolveSource(args.config), {
      root: process.cwd(),
    });
    await run({
      client,
      id: summary.id,
      kind: "remote",
      workspace: client.workspace(summary),
    });
  } finally {
    client.close();
  }
}
