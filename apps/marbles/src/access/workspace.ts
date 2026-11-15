import { Tasks } from "@foundry/tasks";
import { changeTasks, readTasks } from "~/database/tasks";
import { layout } from "~/layout";
import { insideState } from "~/lib/state/workspace";
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
import { resolveSource } from "~/workspace/source";
import { runTaskCommand } from "~/workspace/tasks";

/**
 * How a command reaches its workspace, for the CLI and the MCP server
 * alike. There are three ways:
 *
 * - Stored state: the workspace's rows in the Marbles database, opened
 *   for each command and closed after it. No source runs.
 * - A running instance: the engine generation of a Marbles process that already hosts
 *   the workspace, joined without starting anything.
 * - Start and host: attach the workspace to the Marbles process, starting
 *   one when none runs, or host it in this process under `--dry-run`. Only
 *   the CLI starts or hosts anything.
 */

/** Runs one task command on a workspace's own tasks; a refusal is a `TaskError`. */
export type TaskRunner = <K extends TaskCommandKind>(
  command: TaskCommand<K>
) => Promise<TaskCommandResult<K>>;

/** No running instance hosts the workspace a command needs one for. */
export class NotHostedError extends Error {
  override readonly name = "NotHostedError";
}

/** The Marbles process is about to host the workspace whose tasks a command asked for: retry once it is ready. */
export class RecordsHeldError extends Error {
  override readonly name = "RecordsHeldError";
}

const ATTACH_HINT = "`marbles attach` in its root hosts it";

/**
 * The workspace's tasks from stored state, each command on its own opening
 * of the Marbles database: a read through a read-only connection that
 * never creates, migrates or changes it (no database reads as no tasks);
 * a change as a writer under the state root's lock rule, which makes the
 * database when no Marbles process holds the state root. Under `--dry-run`
 * they are in memory, for as long as `work` runs.
 */
function withStoredTasks<T>(
  args: HostOptions,
  opened: OpenedWorkspace,
  work: (tasks: TaskRunner) => Promise<T>
): Promise<T> {
  if (args.dry) {
    const tasks = new Tasks();
    return work((command) => runTaskCommand(tasks, command));
  }
  const { state } = args;
  const { id } = opened.workspace;
  return work((command) =>
    (command.kind === "change" ? changeTasks : readTasks)(state, id, (tasks) =>
      runTaskCommand(tasks, command)
    )
  );
}

/** The running Marbles process, joined without starting one; undefined when none runs. */
export async function joinProcess(): Promise<MarblesClient | undefined> {
  try {
    return await connect({ layout: layout(), start: false });
  } catch (error) {
    if (error instanceof NoProcessError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The engine generation that hosts the workspace now, when a Marbles process runs and
 * has it ready. Nothing is started or attached to find out. A workspace that
 * is starting is about to host the tasks, so the command is refused rather
 * than going around it.
 */
async function hostingWorker(
  id: string
): Promise<
  | { readonly client: MarblesClient; readonly workspace: WorkspaceConnection }
  | undefined
> {
  const client = await joinProcess();
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
        `the tasks of this workspace are about to be in use by Marbles process pid ${String(client.hello.pid)}, which has it ${summary.state}; retry once it is ready`
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
 * anything that would. A generation that already hosts the workspace owns
 * them, so each command goes to it; otherwise they come from stored state.
 * `--dry-run` never asks the Marbles process.
 */
export async function withTasks<T>(
  args: HostOptions,
  opened: OpenedWorkspace,
  work: (tasks: TaskRunner) => Promise<T>
): Promise<T> {
  const { dir, id } = opened.workspace;
  const { state } = args;
  // A link there would put the tasks, locks and sessions somewhere else.
  if (!(args.dry || insideState(state, id))) {
    throw new Error(
      `the state of workspace ${id} at ${dir} is not a directory inside ${state}`
    );
  }
  const hosted = args.dry ? undefined : await hostingWorker(id);
  if (hosted === undefined) {
    return withStoredTasks(args, opened, work);
  }
  try {
    return await work((command) => hosted.workspace.tasks(command));
  } finally {
    hosted.client.close();
  }
}

/**
 * Run `work` against the generation that hosts workspace `id` and has it ready.
 * Nothing is started or attached: without such a generation this rejects with a
 * `NotHostedError` that names the command that hosts it. `--dry-run` joins
 * no process, so it always rejects.
 */
export async function withRunningWorkspace<T>(
  args: HostOptions,
  id: string,
  work: (workspace: WorkspaceConnection) => Promise<T>
): Promise<T> {
  if (args.dry) {
    throw new NotHostedError(
      `--dry-run joins no Marbles process, so no engine generation is reached for workspace ${id}; without --dry-run, ${ATTACH_HINT}. A dry run of a workflow goes through \`marbles roll --dry-run\`.`
    );
  }
  const client = await joinProcess();
  if (client === undefined) {
    throw new NotHostedError(
      `no Marbles process runs for ${args.state}, so nothing hosts workspace ${id}; ${ATTACH_HINT}`
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
        `workspace ${id} is ${summary.state} in the Marbles process; retry once it is ready`
      );
    }
    if (summary.state !== "ready") {
      throw new NotHostedError(
        `workspace ${id} is ${summary.state} in the Marbles process${summary.error ? `: ${summary.error}` : ""}; ${ATTACH_HINT}`
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
  options: Pick<HostWorkspaceOptions, "env" | "print">
): Promise<WorkspaceHost> {
  return hostWorkspace({
    ...options,
    artifacts: args.artifacts,
    directory: args.directory,
    dry: args.dry,
    source: args.config,
    state: args.state,
  });
}

/** Attach the workspace to the Marbles process, starting one when none runs. */
export async function attachToProcess(
  args: HostOptions & { readonly directory: string },
  run: (hosted: Hosted) => Promise<void>
): Promise<void> {
  const client = await connect({ layout: layout() });
  try {
    const summary = await client.attach(
      resolveSource(args.config, args.directory),
      { root: args.directory }
    );
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
