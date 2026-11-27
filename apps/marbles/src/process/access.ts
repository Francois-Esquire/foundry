import { changeTasks, readTasks } from "~/database/open";
import { layout } from "~/layout";
import { insideState } from "~/lib/state/workspace";
import type { WorkspaceConnection } from "~/model/connection";
import {
  NotHostedError,
  NotReadyError,
  RecordsHeldError,
} from "~/model/errors";
import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
} from "~/model/tasks";
import type { MarblesClient } from "~/process/client";
import { connect, NoProcessError } from "~/process/client";
import type { WorkspaceHost } from "~/workspace/host";
import type { HostOptions, OpenedWorkspace } from "~/workspace/open";
import { resolveSource } from "~/workspace/source";
import { runTaskCommand } from "~/workspace/tasks";

export type TaskRunner = <K extends TaskCommandKind>(
  command: TaskCommand<K>
) => Promise<TaskCommandResult<K>>;

const ATTACH_HINT = "`marbles start` in its root hosts it";

function withStoredTasks<T>(
  args: HostOptions,
  opened: OpenedWorkspace,
  work: (tasks: TaskRunner) => Promise<T>
): Promise<T> {
  const { state } = args;
  const { id } = opened.workspace;
  return work((command) =>
    (command.kind === "change" ? changeTasks : readTasks)(state, id, (tasks) =>
      runTaskCommand(tasks, command)
    )
  );
}

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

async function hostingGeneration(
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

export async function withTasks<T>(
  args: HostOptions,
  opened: OpenedWorkspace,
  work: (tasks: TaskRunner) => Promise<T>
): Promise<T> {
  const { dir, id } = opened.workspace;
  const { state } = args;
  if (!insideState(state, id)) {
    throw new Error(
      `the state of workspace ${id} at ${dir} is not a directory inside ${state}`
    );
  }
  const hosted = await hostingGeneration(id);
  if (hosted === undefined) {
    return withStoredTasks(args, opened, work);
  }
  try {
    return await work((command) => hosted.workspace.tasks(command));
  } finally {
    hosted.client.close();
  }
}

export async function withRunningWorkspace<T>(
  args: HostOptions,
  id: string,
  work: (workspace: WorkspaceConnection) => Promise<T>
): Promise<T> {
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
      throw new NotReadyError(
        `workspace ${id} is ${summary.state} in the Marbles process; retry once it is ready`
      );
    }
    if (summary.state !== "ready") {
      const Refusal =
        summary.state === "stopped" ? NotHostedError : NotReadyError;
      throw new Refusal(
        `workspace ${id} is ${summary.state} in the Marbles process${summary.error ? `: ${summary.error}` : ""}; ${ATTACH_HINT}`
      );
    }
    return await work(client.workspace(summary));
  } finally {
    client.close();
  }
}

export type Hosted =
  | { readonly kind: "local"; readonly host: WorkspaceHost }
  | {
      readonly kind: "remote";
      readonly client: MarblesClient;
      readonly id: string;
      readonly workspace: WorkspaceConnection;
    };

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
