#!/usr/bin/env bun
import { connect as connectSocket, type Socket } from "node:net";
import { thisProcess } from "@foundry/lib/node/process-identity";

import { layout } from "~/layout";
import type { Engine } from "~/lib/engine";
import type { QueuedAdoption } from "~/lib/launcher";
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
  handedParamsSchema,
  hostParamsSchema,
  isWorkspaceMethod,
  liveRunsSchema,
  queuedParamsSchema,
  retireParamsSchema,
  runListQuerySchema,
  startParamsSchema,
  workspaceIdSchema,
} from "~/process/protocol";
import { envFilesLoaded } from "~/process/runtime";
import { dispatchSchema } from "~/workspace/dispatch";
import type { GenerationHost, WorkspaceHost } from "~/workspace/host";
import type { StagedWorkspaces, WorkspaceLoad } from "~/workspace/hosted";
import { HostedWorkspaces } from "~/workspace/hosted";
import { liveRuns } from "~/workspace/live-work";
import {
  registerSetupStep,
  SETUP_STEP,
  type SetupInput,
} from "~/workspace/setup-step";
import { taskCommandSchema, taskOutcome } from "~/workspace/tasks";
import type { SetupDraft } from "~/workspace/templates";

interface GenerationArgs {
  readonly artifacts: string;
  readonly dry: boolean;
  readonly socket: string;
  readonly spawned: string;
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
  const { artifacts, spawned, state } = layout();
  return {
    artifacts,
    dry,
    socket: required("socket"),
    spawned,
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
  host: GenerationHost,
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
      return host.dispatchAgent(dispatchSchema.parse(p));
    case "dispatchWorkflow":
      return host.dispatchWorkflow(text(p.name, "name"), p.input, {
        ...(p.key === undefined ? {} : { key: text(p.key, "key") }),
      });
    case "getRun":
      return host.getRun(text(p.runId, "runId"));
    case "launch":
      return host.actions.launch(
        text(p.name, "name"),
        p.input as Parameters<typeof host.actions.launch>[1]
      );
    case "listRuns":
      return host.listRuns(runListQuerySchema.parse(p.query ?? {}));
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
    case "send":
      return runs.send(text(p.runId, "runId"), text(p.stepId, "stepId"), {
        target: text(p.target, "target"),
        text: text(p.text, "text"),
      });
    case "setTriggerEnabled":
      return runs.setTriggerEnabled(
        text(p.triggerId, "triggerId"),
        p.enabled === true
      );
    case "snapshot":
      return host.snapshot(liveRunsSchema.parse(p.live ?? []));
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

interface Ticking {
  readonly cancel: AbortController;
  readonly done: Promise<void>;
  readonly stop: AbortController;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let hosted: HostedWorkspaces | undefined;
  let staged: StagedWorkspaces | undefined;
  const ticking = new Map<string, Ticking>();
  const loops = new Set<Ticking>();
  let retiring: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let orphaning = false;
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
    const loop = { cancel, done, stop };
    ticking.set(host.id, loop);
    loops.add(loop);
    done.finally(() => loops.delete(loop)).catch(() => undefined);
  };

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

  const postSetup = (host: WorkspaceHost, draft: SetupDraftParams): void => {
    const input: SetupInput = {
      configPath: host.configPath,
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
      read(root, file) {
        notify(GENERATION_NOTIFICATIONS.read, {
          file,
          readAt: Date.now(),
          root,
        });
      },
      ...(args.dry ? {} : { spawned: args.spawned }),
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

  const leave = async (cancel: boolean): Promise<void> => {
    await Promise.all([...ticking.keys()].map((id) => untick(id, cancel)));
    await Promise.allSettled(
      (hosted?.list() ?? []).map((each) => each.engine.stop())
    );
    await Promise.allSettled(unhosting.values());
    await staged?.abandon().catch(() => undefined);
    await hosted?.close();
  };

  const retire = async (raw: unknown): Promise<void> => {
    const { successor } = retireParamsSchema.parse(raw);
    if (retiring !== undefined || stopping !== undefined) {
      throw new Error("this generation is already retiring or stopping");
    }
    const hosts = (hosted?.list() ?? []).filter(
      (each) => !unhosting.has(each.id)
    );
    for (const each of hosts) {
      const loop = ticking.get(each.id);
      loop?.stop.abort();
    }
    const handing = hosts.map((each) =>
      each.engine.retire(successor, {
        onHanded(runId) {
          notify(GENERATION_NOTIFICATIONS.handed, { id: each.id, runId });
        },
      })
    );
    retiring = (async () => {
      const retired = await Promise.allSettled(handing);
      await Promise.all(
        retired.map((each) =>
          each.status === "fulfilled" ? each.value.ended : undefined
        )
      );
      await leave(false);
    })();
    retiring.then(finished.resolve, finished.reject);
    await Promise.all(handing);
  };

  const takeHanded = async (raw: unknown): Promise<boolean> => {
    const { id, runId } = handedParamsSchema.parse(raw);
    if (retiring !== undefined || stopping !== undefined) {
      return false;
    }
    return await workspaces().get(id).engine.takeHanded(runId);
  };

  const adoptQueued = async (raw: unknown): Promise<QueuedAdoption> => {
    const { id, owner, runId } = queuedParamsSchema.parse(raw);
    if (retiring !== undefined || stopping !== undefined) {
      return { taken: false, why: "its generation is retiring or stopping" };
    }
    return await workspaces().get(id).engine.adoptQueued(runId, owner);
  };

  const liveWork = async (raw: unknown): Promise<unknown> => {
    const { id } = workspaceIdSchema.parse(raw);
    const { engine } = workspaces().get(id);
    return liveRuns(await engine.runs(), engine.scopes);
  };

  const stop = (): Promise<void> => {
    if (orphaning) {
      for (const loop of loops) {
        loop.cancel.abort();
      }
    }
    stopping ??= retiring ?? leave(true);
    stopping.then(finished.resolve, finished.reject);
    return stopping;
  };

  const orphaned = async (): Promise<void> => {
    for (const loop of loops) {
      loop.stop.abort();
    }
    await Promise.allSettled(
      (hosted?.list() ?? []).map((each) => each.engine.stop())
    );
    await leave(false);
  };

  const orphan = (): Promise<void> => {
    orphaning ||= retiring === undefined && stopping === undefined;
    stopping ??= retiring ?? orphaned();
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
        case GENERATION_METHODS.takeHanded:
          return takeHanded(raw);
        case GENERATION_METHODS.takeQueued:
          return adoptQueued(raw);
        case GENERATION_METHODS.liveWork:
          return liveWork(raw);
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
      let target: GenerationHost;
      try {
        target = workspaces().get(id);
      } catch (error) {
        return Promise.reject(error);
      }
      return call(target, name, rest);
    },
  });
  await channel.request(DAEMON_METHODS.register, { token: args.token });
  channel.closed.then(() => orphan()).catch(() => undefined);
  process.once("SIGTERM", () => {
    stop().catch(() => undefined);
  });
  process.once("SIGINT", () => {
    stop().catch(() => undefined);
  });
  try {
    await finished.promise;
  } finally {
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
