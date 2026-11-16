#!/usr/bin/env bun
import { connect as connectSocket, type Socket } from "node:net";
import {
  type ProcessIdentity,
  thisProcess,
} from "@foundry/lib/process-identity";
import { readLiveGenerations } from "~/database/generations";

import { layout } from "~/layout";
import type { Engine } from "~/lib/engine";
import { Channel, socketTransport } from "~/process/channel";
import type {
  LoadResult,
  SetupDraftParams,
  WorkspaceLoadResult,
  WorkspaceMethod,
} from "~/process/protocol";
import {
  DAEMON_METHODS,
  GENERATION_METHODS,
  GENERATION_NOTIFICATIONS,
  hostParamsSchema,
  isWorkspaceMethod,
  releasedParamsSchema,
  retireParamsSchema,
  startParamsSchema,
  workspaceIdSchema,
} from "~/process/protocol";
import { envFilesLoaded } from "~/process/runtime";
import { SPAWN_RECOVERY_ENV } from "~/process/spawned";
import { dispatchSchema } from "~/workspace/dispatch";
import type { WorkspaceHost } from "~/workspace/host";
import type { StagedWorkspaces, WorkspaceLoad } from "~/workspace/hosted";
import { HostedWorkspaces } from "~/workspace/hosted";
import {
  registerSetupStep,
  SETUP_STEP,
  type SetupInput,
} from "~/workspace/setup-step";
import { taskCommandSchema, taskOutcome } from "~/workspace/tasks";
import type { SetupDraft } from "~/workspace/templates";

/**
 * One engine generation: the process the daemon spawns to host every
 * registered workspace, each in an engine of its own over one handle on
 * the Marbles database. It is isolated from the daemon, so a misbehaving
 * module takes down the generation, never the daemon. It dials the
 * daemon's socket and registers with the token it was spawned with; then
 * the daemon drives it:
 *
 * - `load` loads every registered workspace up to engines not yet
 *   started, and says how each went: whether this generation can take
 *   over at all. It holds nothing of the workspaces' work yet.
 * - `start` starts those engines, which takes over parked and queued
 *   work, and ticks each workspace's triggers.
 * - `host` and `unhost` add one workspace, or drop one, while it runs.
 * - `retire` hands what is not running to the generation that takes over
 *   (`Engine.retire`) and stops the triggers; the runs still running here
 *   then run to their end, a run that parks meanwhile is let go and the
 *   daemon told (`released`), and the generation exits.
 * - `adopt` takes over a parked run a retired generation let go.
 * - `stop` drains running work and exits.
 *
 * Workspace methods arrive as `workspace.<name>` with the workspace's id,
 * and status lines go out as notifications. The daemon watches the
 * sources itself, to decide when the next generation starts.
 */

interface GenerationArgs {
  /** The shared artifact store, under the Foundry home `FOUNDRY_HOME` names. */
  readonly artifacts: string;
  readonly dry: boolean;
  /** The daemon's socket, and what to say on it. */
  readonly socket: string;
  /** The Marbles state root, under the Foundry home `FOUNDRY_HOME` names. */
  readonly state: string;
  readonly token: string;
}

function parseArgs(argv: readonly string[]): GenerationArgs {
  const values = new Map<string, string>();
  let dry = false;
  const words = argv.values();
  for (const word of words) {
    if (word === "--dry-run") {
      dry = true;
    } else if (word.startsWith("--")) {
      const { value } = words.next();
      if (value !== undefined) {
        values.set(word.slice(2), value);
      }
    }
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) {
      throw new Error(`a generation needs --${name}`);
    }
    return value;
  };
  // The daemon names its Foundry home in the generation's environment.
  const { artifacts, state } = layout();
  return {
    artifacts,
    dry,
    socket: required("socket"),
    state,
    token: required("token"),
  };
}

type Params = Record<string, unknown>;

function params(value: unknown): Params {
  return typeof value === "object" && value !== null ? (value as Params) : {};
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`"${name}" must be a string`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function call(
  host: WorkspaceHost,
  method: WorkspaceMethod,
  raw: unknown
): Promise<unknown> {
  const p = params(raw);
  const { runs } = host.actions;
  switch (method) {
    case "answer":
      return host.actions.answer(
        text(p.entryId, "entryId"),
        p.answer as Parameters<typeof host.actions.answer>[1]
      );
    case "cancel":
      return runs.cancel(text(p.runId, "runId"));
    case "cancelRun":
      return host.cancelRun(text(p.runId, "runId"));
    case "deleteTrigger":
      return runs.deleteTrigger(text(p.triggerId, "triggerId"));
    case "describe":
      return host.describe();
    case "dispatchAgent":
      // MCP validates what it dispatches; a raw client on the socket may not.
      return host.dispatchAgent(dispatchSchema.parse(p));
    case "dispatchWorkflow":
      return host.dispatchWorkflow(text(p.name, "name"), p.input);
    case "getRun":
      return host.getRun(text(p.runId, "runId"));
    case "launch":
      return host.actions.launch(
        text(p.name, "name"),
        p.input as Parameters<typeof host.actions.launch>[1]
      );
    case "pause":
      return runs.pause(text(p.runId, "runId"), text(p.stepId, "stepId"));
    case "resume":
      return runs.resume(
        text(p.runId, "runId"),
        text(p.stepId, "stepId"),
        optionalText(p.prompt)
      );
    case "roll":
      return host.roll(text(p.name, "name"), p.input);
    case "setTriggerEnabled":
      return runs.setTriggerEnabled(
        text(p.triggerId, "triggerId"),
        p.enabled === true
      );
    case "snapshot":
      return host.snapshot();
    case "steer":
      return runs.steer(
        text(p.runId, "runId"),
        text(p.stepId, "stepId"),
        text(p.prompt, "prompt")
      );
    case "stopActivity":
      return runs.stopActivity(
        text(p.sessionId, "sessionId"),
        text(p.activityId, "activityId")
      );
    case "tasks":
      // Checked as MCP and the CLI check it; a raw client on the socket may not.
      return taskOutcome(host.tasks(taskCommandSchema.parse(p.command)));
    default:
      return Promise.reject(
        new Error(`no workspace method "${String(method satisfies never)}"`)
      );
  }
}

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function loadResult(load: WorkspaceLoad): WorkspaceLoadResult {
  return load.loaded
    ? { id: load.id, root: load.root }
    : { error: load.error.message, root: load.root };
}

/** One hosted workspace's triggers, and how to stop them. */
interface Ticking {
  /** Cancels the run a tick under way started. */
  readonly cancel: AbortController;
  /** Resolves once the loop has stopped, its last tick ended. */
  readonly done: Promise<void>;
  /** Stops the loop: no tick starts again. */
  readonly stop: AbortController;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let hosted: HostedWorkspaces | undefined;
  let staged: StagedWorkspaces | undefined;
  const ticking = new Map<string, Ticking>();
  let retiring: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  /** Resolves once this generation is done: stopped, or retired with nothing left running. */
  const finished = Promise.withResolvers<void>();

  const workspaces = (): HostedWorkspaces => {
    if (hosted === undefined) {
      throw new Error("this generation has not loaded its workspaces yet");
    }
    return hosted;
  };

  const notify = (method: string, payload?: unknown): void => {
    if (channel.open) {
      channel.notify(method, payload);
    }
  };

  /** Tick `host`'s triggers until stopped. */
  const tick = (host: WorkspaceHost): void => {
    const stop = new AbortController();
    const cancel = new AbortController();
    const done = (async () => {
      host.setStatus(
        (await host.engine.schedules()).length === 0
          ? "Ready · no triggers configured"
          : "Watching triggers"
      );
      await host.run(stop.signal, cancel.signal);
    })().catch((error: unknown) =>
      notify(GENERATION_NOTIFICATIONS.line, {
        line: `[schedule] ${String(error)}`,
        root: host.root,
      })
    );
    ticking.set(host.id, { cancel, done, stop });
  };

  /** Stop ticking workspace `id`; with `cancel`, the tick under way is cut short too. */
  const untick = async (id: string, cancel: boolean): Promise<void> => {
    const loop = ticking.get(id);
    if (loop === undefined) {
      return;
    }
    ticking.delete(id);
    loop.stop.abort();
    if (cancel) {
      loop.cancel.abort();
    }
    await loop.done;
  };

  /** Onboarding's feed entry comes from a real Run, like every other entry. */
  const postSetup = (host: WorkspaceHost, draft: SetupDraftParams): void => {
    const input: SetupInput = {
      configPath: host.configPath,
      // The client wrote the starter it names; its template is one it knows.
      draft: draft as SetupDraft,
      root: host.root,
    };
    host.engine
      .run(SETUP_STEP, input)
      .catch((error: unknown) => host.setStatus(`[feed] ${String(error)}`));
  };

  const open = async (): Promise<HostedWorkspaces> => {
    hosted ??= await HostedWorkspaces.open({
      artifacts: args.artifacts,
      askable: true,
      dry: args.dry,
      prepare(engine: Engine) {
        registerSetupStep(engine);
      },
      print(root, line) {
        notify(GENERATION_NOTIFICATIONS.line, { line, root });
      },
      // What this generation depends on, as it reads it: the daemon's
      // fingerprint of it records each file as it was when read.
      read(root, file) {
        notify(GENERATION_NOTIFICATIONS.read, {
          file,
          readAt: Date.now(),
          root,
        });
      },
      // The daemon names it, under its Foundry home.
      ...(process.env[SPAWN_RECOVERY_ENV]
        ? { spawned: process.env[SPAWN_RECOVERY_ENV] }
        : {}),
      state: args.state,
    });
    return hosted;
  };

  const load = async (): Promise<LoadResult> => {
    if (staged !== undefined) {
      throw new Error("this generation has loaded its workspaces already");
    }
    staged = await (await open()).stageRegistered();
    const { pid, started } = thisProcess();
    return { identity: { pid, started }, loads: staged.loads.map(loadResult) };
  };

  const start = async (raw: unknown) => {
    const { setups = {} } = startParamsSchema.parse(raw ?? {});
    if (staged === undefined) {
      throw new Error("this generation has nothing loaded to start");
    }
    const loads = await staged.start();
    // Told to stop or retire while the engines started: none ticks.
    if (stopping !== undefined || retiring !== undefined) {
      throw new Error("this generation stopped while it started");
    }
    for (const host of workspaces().list()) {
      tick(host);
      const draft = setups[host.id];
      if (draft !== undefined) {
        postSetup(host, draft);
      }
    }
    return { loads: loads.map(loadResult) };
  };

  const addWorkspace = async (raw: unknown) => {
    const { config, root, setup } = hostParamsSchema.parse(raw);
    const away = () => stopping !== undefined || retiring !== undefined;
    if (away()) {
      throw new Error("this generation is retiring or stopping");
    }
    const all = await open();
    const added = await all.register({ config, root });
    // Retiring or stopping meanwhile: it is not ticked here, and closes
    // with the rest as this generation leaves.
    if (away()) {
      throw new Error("this generation began to retire or stop as it loaded");
    }
    if (!ticking.has(added.id)) {
      tick(added);
    }
    if (setup !== undefined) {
      postSetup(added, setup);
    }
    return { config: added.config, id: added.id, root: added.root };
  };

  /**
   * Workspaces being unhosted, each its drain: a retirement leaves each to
   * it, and the hosts close only once each has dropped its registration.
   */
  const unhosting = new Map<string, Promise<void>>();

  const unhost = (raw: unknown): Promise<void> => {
    const { id } = workspaceIdSchema.parse(raw);
    const under = unhosting.get(id);
    if (under !== undefined) {
      return under;
    }
    const draining = (async () => {
      await untick(id, false);
      const all = workspaces();
      const found = all.list().find((each) => each.id === id);
      // Drain: running work finishes before the workspace closes.
      await found?.engine.stop();
      await all.unregister(id);
    })();
    unhosting.set(id, draining);
    const forget = () => {
      unhosting.delete(id);
    };
    draining.then(forget, forget);
    return draining;
  };

  /** Close what this generation holds, its engines stopped first. */
  const leave = async (cancel: boolean): Promise<void> => {
    await Promise.all([...ticking.keys()].map((id) => untick(id, cancel)));
    // Drain: running work finishes, parked runs stay for the next generation.
    await Promise.allSettled(
      (hosted?.list() ?? []).map((each) => each.engine.stop())
    );
    // A workspace being unhosted drops its registration before the hosts,
    // and the database handle under them, close.
    await Promise.allSettled(unhosting.values());
    await staged?.abandon().catch(() => undefined);
    await hosted?.close();
  };

  /** The generation the Marbles database records current now, as a process. */
  const currentGeneration = async (): Promise<ProcessIdentity | undefined> => {
    const now = (await readLiveGenerations(args.state)).find(
      (each) => each.state === "current"
    );
    return now === undefined || now.pid <= 0
      ? undefined
      : { pid: now.pid, started: now.started };
  };

  const retire = async (raw: unknown): Promise<void> => {
    const { successor } = retireParamsSchema.parse(raw);
    if (retiring !== undefined || stopping !== undefined) {
      throw new Error("this generation is already retiring or stopping");
    }
    // One being unhosted is not handed to the successor, which does not
    // host it: its drain runs what it has here, queued runs too.
    const hosts = (hosted?.list() ?? []).filter(
      (each) => !unhosting.has(each.id)
    );
    // No tick starts here again; one under way runs to its end.
    for (const each of hosts) {
      const loop = ticking.get(each.id);
      loop?.stop.abort();
    }
    const retired = await Promise.all(
      hosts.map((each) =>
        each.engine.retire(successor, {
          // A queued run handed over late is the current generation's.
          onHanded(runId) {
            notify(GENERATION_NOTIFICATIONS.handed, { id: each.id, runId });
          },
          // A run that parks from now on is the current generation's.
          onLetGo(runId) {
            notify(GENERATION_NOTIFICATIONS.released, { id: each.id, runId });
          },
          successorNow: currentGeneration,
        })
      )
    );
    retiring = (async () => {
      await Promise.all(retired.map(({ ended }) => ended));
      await leave(false);
    })();
    retiring.then(finished.resolve, finished.reject);
  };

  const adopt = async (raw: unknown): Promise<boolean> => {
    const { id, runId } = releasedParamsSchema.parse(raw);
    if (retiring !== undefined || stopping !== undefined) {
      return false;
    }
    return await workspaces().get(id).engine.adopt(runId);
  };

  const stop = (): Promise<void> => {
    stopping ??= retiring ?? leave(true);
    stopping.then(finished.resolve, finished.reject);
    return stopping;
  };

  const socket = await dial(args.socket);
  const channel: Channel = new Channel(socketTransport(socket), {
    request(method, raw) {
      switch (method) {
        case GENERATION_METHODS.stop:
          return stop();
        case GENERATION_METHODS.load:
          return load();
        case GENERATION_METHODS.start:
          return start(raw);
        case GENERATION_METHODS.host:
          return addWorkspace(raw);
        case GENERATION_METHODS.unhost:
          return unhost(raw);
        case GENERATION_METHODS.retire:
          return retire(raw);
        case GENERATION_METHODS.adopt:
          return adopt(raw);
        default:
          break;
      }
      if (!method.startsWith("workspace.")) {
        return Promise.reject(new Error(`no generation method "${method}"`));
      }
      const name = method.slice("workspace.".length);
      if (!isWorkspaceMethod(name)) {
        return Promise.reject(new Error(`no workspace method "${name}"`));
      }
      const { id, ...rest } = workspaceIdSchema.passthrough().parse(raw);
      let target: WorkspaceHost;
      try {
        target = workspaces().get(id);
      } catch (error) {
        return Promise.reject(error);
      }
      return call(target, name, rest);
    },
  });
  await channel.request(DAEMON_METHODS.register, { token: args.token });
  // The daemon is gone: nothing can reach this generation, so drain and
  // leave. The reason stays unreported on purpose: this process's only log
  // is its stderr pipe into that daemon, and writing to it now would fail.
  channel.closed.then(() => stop()).catch(() => undefined);
  process.once("SIGTERM", () => {
    stop().catch(() => undefined);
  });
  process.once("SIGINT", () => {
    stop().catch(() => undefined);
  });
  try {
    await finished.promise;
  } finally {
    // A reply to the request that finished it is on its way out first.
    await new Promise((resolve) => setImmediate(resolve));
    socket.end();
  }
}

try {
  const refusal = envFilesLoaded();
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
process.exit(0);
