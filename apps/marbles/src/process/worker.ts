#!/usr/bin/env bun
import { connect as connectSocket, type Socket } from "node:net";
import type { Engine } from "~/lib/engine";
import type { DispatchOptions } from "~/model/connection";

import { Channel, socketTransport } from "~/process/channel";
import type { ProcessInstance } from "~/process/instance";
import { claimProcess } from "~/process/instance";
import type { WorkspaceMethod } from "~/process/protocol";
import {
  DAEMON_METHODS,
  isWorkspaceMethod,
  type ReadyParams,
  WORKER_METHODS,
  WORKER_NOTIFICATIONS,
} from "~/process/protocol";
import type { WorkspaceHost } from "~/workspace/host";
import { hostWorkspace } from "~/workspace/host";
import {
  registerSetupStep,
  SETUP_STEP,
  type SetupInput,
} from "~/workspace/setup-step";
import type { SetupDraft } from "~/workspace/templates";
import { watchSource } from "~/workspace/watch";

/**
 * One workspace's worker: the process the daemon spawns to host it. It is
 * the only process in Marbles that imports authoring modules, so a module
 * that misbehaves takes down this worker and nothing else, and a source
 * edit is a restart of it. It dials the daemon's socket and registers with
 * the token it was spawned with: workspace methods come in as requests,
 * status lines and source changes go out as notifications, and `stop`
 * drains running work before it exits.
 */

interface WorkerArgs {
  readonly artifacts: string;
  readonly dry: boolean;
  readonly only: readonly string[];
  /** A starter the client just wrote: post its milestone once the engine runs. */
  readonly setup?: SetupDraft;
  /** The daemon's socket, and what to say on it. */
  readonly socket: string;
  readonly source: string;
  readonly state: string;
  readonly token: string;
}

function parseWorkerArgs(argv: readonly string[]): WorkerArgs {
  const values = new Map<string, string>();
  const only: string[] = [];
  let dry = false;
  const words = argv.values();
  for (const word of words) {
    if (word === "--dry-run") {
      dry = true;
    } else if (word === "--harness") {
      const id = words.next().value;
      if (id) {
        only.push(id);
      }
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
      throw new Error(`worker needs --${name}`);
    }
    return value;
  };
  const setup = values.get("setup");
  return {
    artifacts: required("artifacts"),
    dry,
    only,
    ...(setup === undefined ? {} : { setup: JSON.parse(setup) as SetupDraft }),
    socket: required("socket"),
    source: required("source"),
    state: required("state"),
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

/** Call the host method a request names, with its params as arguments. */
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
      return host.dispatchAgent(p as unknown as DispatchOptions);
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

async function main(): Promise<void> {
  const args = parseWorkerArgs(process.argv.slice(2));
  const controller = new AbortController();
  let host: WorkspaceHost | undefined;
  let claim: ProcessInstance | undefined;
  let loop: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      controller.abort();
      try {
        await loop;
      } finally {
        try {
          // Drain: running work finishes, parked runs stay for the next worker.
          await host?.engine.stop();
          await host?.close();
        } finally {
          claim?.release();
        }
      }
    })();
    return stopping;
  };

  const socket = await dial(args.socket);
  const channel = new Channel(socketTransport(socket), {
    request(method, raw) {
      if (method === WORKER_METHODS.stop) {
        return stop();
      }
      if (!host) {
        return Promise.reject(new Error("the workspace is still starting"));
      }
      if (!isWorkspaceMethod(method)) {
        return Promise.reject(new Error(`no worker method "${method}"`));
      }
      return call(host, method, raw);
    },
  });
  // The daemon is gone: nothing can reach this worker, so drain and leave.
  channel.closed.then(() => stop()).catch(() => undefined);
  await channel.request(DAEMON_METHODS.register, { token: args.token });
  process.once("SIGTERM", () => {
    stop().catch(() => undefined);
  });
  process.once("SIGINT", () => {
    stop().catch(() => undefined);
  });

  host = await hostWorkspace({
    artifacts: args.artifacts,
    askable: true,
    dry: args.dry,
    only: args.only,
    prepare(engine: Engine) {
      registerSetupStep(engine);
      // This worker is the workspace's one Marbles process; claimed before
      // the engine starts and adopts parked runs. A dry run claims nothing.
      if (engine.state !== undefined) {
        claim = claimProcess(engine.state, {
          config: args.source,
          host: "worker",
        });
      }
    },
    print(line) {
      channel.notify(WORKER_NOTIFICATIONS.line, { line });
    },
    source: args.source,
    state: args.state,
  });
  const ready: ReadyParams = {
    config: host.config,
    configPath: host.configPath,
    id: host.id,
    root: host.root,
  };
  channel.notify(WORKER_NOTIFICATIONS.ready, ready);
  if (args.setup !== undefined) {
    // Onboarding's feed entry comes from a real Run, like every other entry.
    const input: SetupInput = {
      configPath: host.configPath,
      draft: args.setup,
      root: host.root,
    };
    host.engine
      .run(SETUP_STEP, input)
      .catch((error: unknown) => host.setStatus(`[feed] ${String(error)}`));
  }
  watchSource(host.configPath, {
    onChange() {
      channel.notify(WORKER_NOTIFICATIONS.sourceChanged);
    },
    signal: controller.signal,
  });
  host.setStatus(
    host.engine.schedules().length === 0
      ? "Ready · no triggers configured"
      : "Watching triggers"
  );
  loop = host.run(controller.signal);
  await loop;
  await stop();
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
process.exit(0);
