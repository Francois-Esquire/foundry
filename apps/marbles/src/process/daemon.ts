import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { holdsLock } from "@foundry/lib/file-lock";
import {
  type ProcessIdentity,
  sameProcess,
} from "@foundry/lib/process-identity";
import { readExecution } from "~/database/executions";
import { GenerationRecords } from "~/database/generations";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { WorkspaceRegistry } from "~/database/workspaces";
import type { Layout } from "~/layout";
import {
  insideState,
  type Workspace,
  type WorkspaceRecord,
} from "~/lib/state/workspace";
import type { WorkspaceSummary } from "~/model/connection";
import { Channel, socketTransport } from "~/process/channel";
import type { ProcessInstance } from "~/process/instance";
import { claimProcess } from "~/process/instance";
import {
  attachParamsSchema,
  CLIENT_NOTIFICATIONS,
  DAEMON_METHODS,
  GENERATION_METHODS,
  GENERATION_NOTIFICATIONS,
  GENERATION_STOP_TIMEOUT_MS,
  type HelloResult,
  hostResultSchema,
  isWorkspaceMethod,
  type LoadResult,
  lineParamsSchema,
  loadResultSchema,
  PROTOCOL,
  registerParamsSchema,
  type SetupDraftParams,
  startResultSchema,
  WORKSPACE_METHODS,
  WORKSPACE_PREFIX,
  type WorkspaceLoadResult,
  workspaceIdSchema,
} from "~/process/protocol";
import { RUNTIME_FLAGS, runtime } from "~/process/runtime";
import { recordSpawned, SPAWN_RECOVERY_ENV } from "~/process/spawned";
import {
  DEFAULT_SOURCE,
  resolveSource,
  sourceFiles,
  sourceRoot,
} from "~/workspace/source";
import { sourceDigest } from "~/workspace/watch";
import { version } from "../../package.json";

/**
 * The Marbles process: one per machine, claimed at the state root, holding
 * no engine of its own. Every registered workspace is hosted in one engine
 * subprocess, a generation (`generation.ts`), which dials the daemon's
 * Unix socket and registers with the token it was spawned with, so one
 * transport carries clients and generations alike. The daemon answers
 * clients, keeps their subscriptions by workspace, and routes each
 * workspace method to the generation that has it. It never imports an
 * authoring module: a source that fails loads in a generation and fails
 * there.
 *
 * A change of what the current generation loaded (its fingerprint: the
 * installation and every workspace's source), a reload, or a generation
 * that died, starts a candidate generation. The switch:
 *
 * 1. The candidate loads every registered workspace up to engines not
 *    yet started. One that does not load is an error, and nothing
 *    switches: the current generation keeps running. (At boot, with none
 *    running, a workspace that does not load is reported failed and the
 *    rest run.) A candidate that fails is not tried again for the same
 *    fingerprint, so a broken edit is not reloaded in a loop.
 * 2. The current generation retires: it starts no tick and delivers no
 *    change again, hands its queued runs to the candidate and lets its
 *    parked runs go, and goes on with the runs still running there.
 * 3. The candidate starts its engines, which takes over the parked and
 *    queued work, and is current from then on. The retired one exits
 *    once its last run has ended; several may be alive at once.
 *
 * A run is owned by the process of the generation running it, so a
 * command about a run goes to that generation, and an answer to the one
 * holding the question. A generation that dies leaves its runs to the
 * next engine start's crash recovery: the daemon starts one.
 */

export interface DaemonOptions {
  /** The generation entry to spawn; the one beside this module when omitted. */
  readonly generationEntry?: string;
  readonly layout: Layout;
  readonly print?: (line: string) => void;
}

export interface Daemon {
  close(): Promise<void>;
  readonly closed: Promise<void>;
  readonly pid: number;
  readonly socket: string;
}

/** How long a generation gets to answer `stop`, and then to exit, before it is killed. */
const STOP_TIMEOUT_MS = GENERATION_STOP_TIMEOUT_MS;
/** How long a generation gets to register, load and start. */
const READY_TIMEOUT_MS = 120_000;
/** Source edits arrive in bursts; one switch serves them all. */
const SWITCH_DEBOUNCE_MS = 500;
/** How often the fingerprint's sources are digested again. */
const SOURCE_POLL_MS = 1000;
/** How often the installation, many more files, is digested again. */
const INSTALLATION_POLL_MS = 5000;
/** A current generation that dies sooner than this after taking over is not replaced on its own. */
const SETTLE_MS = 5000;
/** Lines of a generation's stderr kept to explain a failure. */
const STDERR_TAIL = 20;
/** How often the daemon checks that the claim at the state root is still its own. */
const CLAIM_CHECK_MS = 5000;

function generationEntry(): string {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./generation.ts" : "./generation.js",
      import.meta.url
    )
  );
}

/** One engine subprocess, from its spawn to its exit. */
interface Generation {
  channel?: Channel;
  readonly child: ChildProcess;
  /** Set once it has exited: why, when it was not a clean exit. */
  exit?: { readonly clean: boolean; readonly why: string };
  /** Resolves when the child exits, or never started. */
  readonly exited: Promise<void>;
  /** What it loaded: compared with what is there now to decide a switch. */
  readonly fingerprint: Fingerprint;
  /** The workspaces it hosts, by id. */
  readonly hosts: Set<string>;
  /** Its process, as it reported it once it loaded. */
  identity?: ProcessIdentity;
  readonly number: number;
  readonly registered: PromiseWithResolvers<Channel>;
  role: "candidate" | "current" | "retiring";
  /** When it became current. */
  since?: number;
  /** Last lines of stderr, for a failure's explanation. */
  readonly tail: string[];
  readonly token: string;
}

/** A workspace the Marbles process hosts, as clients see it. */
interface Hosted {
  /** Handed to the generation that next starts it: it posts the setup milestone. */
  setup?: SetupDraftParams;
  /** Where its source is, or would be. */
  readonly source: string;
  summary: WorkspaceSummary;
}

/** What a generation loaded: the installation, and each workspace's source. */
interface Fingerprint {
  readonly digest: string;
  readonly installation: string;
  /** By workspace id. */
  readonly sources: ReadonlyMap<string, string>;
}

interface Client {
  readonly channel: Channel;
  readonly subscriptions: Set<string>;
}

/** Workspace methods about one run: answered by the generation that runs it. */
const RUN_METHODS = new Set<string>([
  WORKSPACE_METHODS.cancel,
  WORKSPACE_METHODS.cancelRun,
  WORKSPACE_METHODS.getRun,
  WORKSPACE_METHODS.pause,
  WORKSPACE_METHODS.resume,
  WORKSPACE_METHODS.steer,
]);

/** Workspace methods that begin work; the rest read, steer, or end it. */
const DISPATCHING = new Set<string>([
  WORKSPACE_METHODS.dispatchAgent,
  WORKSPACE_METHODS.dispatchWorkflow,
  WORKSPACE_METHODS.launch,
  WORKSPACE_METHODS.resume,
  WORKSPACE_METHODS.roll,
]);

function timeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run `step` on every item, each whatever the others threw, and wait for
 * all of them; then throw the first error, if any.
 */
async function everyOf<T>(
  items: readonly T[],
  step: (item: T) => unknown
): Promise<void> {
  const settled = await Promise.allSettled(
    items.map(async (item) => {
      await step(item);
    })
  );
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failed !== undefined) {
    throw failed.reason;
  }
}

/**
 * A digest of the installation a generation runs from: the Marbles
 * version, and the size and modification time of every file under the
 * directory its entry sits in, the build (`dist`) or the source (`src`).
 */
function installationDigest(entry: string): string {
  const hash = createHash("sha256");
  hash.update(version);
  const top = dirname(dirname(entry));
  const root = entry.endsWith(".ts") ? top : dirname(entry);
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const files = sourceFiles(path, { helpers: true });
      if (files === undefined) {
        walk(path);
        continue;
      }
      hash.update(path);
      hash.update(sourceDigest(path) ?? "missing");
    }
  };
  walk(root);
  return hash.digest("hex");
}

/** Every hosted registration's source digest, by workspace id. */
function sourceDigests(
  records: readonly WorkspaceRecord[]
): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  for (const record of records) {
    const source = record.config ?? join(record.root, DEFAULT_SOURCE);
    digests.set(record.id, sourceDigest(source) ?? "none");
  }
  return digests;
}

function fingerprintOf(
  installation: string,
  sources: ReadonlyMap<string, string>
): Fingerprint {
  const hash = createHash("sha256");
  hash.update(installation);
  for (const [id, digest] of [...sources].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    hash.update(`\0${id}\0${digest}`);
  }
  return { digest: hash.digest("hex"), installation, sources };
}

/** Signal the process group `child` leads; a group already gone is fine. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Gone already, or never a group leader: signal the child itself.
    child.kill(signal);
  }
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { layout } = options;
  const print = options.print ?? (() => undefined);
  const script = options.generationEntry ?? generationEntry();
  mkdirSync(layout.state, { recursive: true });
  const claim: ProcessInstance = claimProcess(layout.state, {
    artifacts: layout.artifacts,
    host: "daemon",
    socket: layout.socket,
    version,
  });
  let database: MarblesDatabase;
  try {
    database = await initializeDatabase(layout.database);
  } catch (error) {
    // The open failing is what is thrown, even if releasing fails too.
    try {
      claim.release();
    } catch {
      // Reported through the error that is thrown instead.
    }
    throw error;
  }
  // Its records leave out a workspace whose directory links out of the
  // state root, so none is hosted again at boot.
  const registry = new WorkspaceRegistry({
    database: database.database,
    state: layout.state,
  });
  const records = new GenerationRecords({ database: database.database });
  const hosted = new Map<string, Hosted>();
  const generations = new Set<Generation>();
  let current: Generation | undefined;
  const clients = new Set<Client>();
  /** Every open connection, clients and generations alike: closing destroys them. */
  const sockets = new Set<Socket>();
  const { startedAt } = claim;
  let closing: Promise<void> | undefined;
  /** Set once a shutdown is asked for: nothing new starts from then on. */
  let stopping = false;
  /** The fingerprint the last candidate that did not load was given: not tried again on its own. */
  let refused: string | undefined;
  let installation = installationDigest(script);
  let installationAt = Date.now();
  let switchTimer: ReturnType<typeof setTimeout> | undefined;

  const hello: HelloResult = {
    artifacts: layout.artifacts,
    pid: process.pid,
    protocol: PROTOCOL,
    startedAt,
    state: layout.state,
    version,
  };

  function publish(workspace: Hosted): void {
    for (const client of clients) {
      if (client.subscriptions.has(workspace.summary.id)) {
        client.channel.notify(
          CLIENT_NOTIFICATIONS.workspace,
          workspace.summary
        );
      }
    }
  }

  function setState(
    workspace: Hosted,
    state: WorkspaceSummary["state"],
    changes: { readonly error?: string; readonly pid?: number } = {}
  ): void {
    const { error: _error, pid: _pid, ...rest } = workspace.summary;
    const pid = changes.pid ?? workspace.summary.pid;
    const next: WorkspaceSummary = {
      ...rest,
      ...(changes.error === undefined ? {} : { error: changes.error }),
      ...(pid === undefined || state === "stopped" ? {} : { pid }),
      state,
    };
    const same =
      workspace.summary.state === next.state &&
      workspace.summary.error === next.error &&
      workspace.summary.pid === next.pid;
    workspace.summary = next;
    if (!same) {
      publish(workspace);
    }
  }

  function forwardLine(id: string | undefined, line: string): void {
    print(`[${id ?? "marbles"}] ${line}`);
    if (id === undefined) {
      return;
    }
    for (const client of clients) {
      if (client.subscriptions.has(id)) {
        client.channel.notify(CLIENT_NOTIFICATIONS.line, { id, line });
      }
    }
  }

  /**
   * Every turn that changes which generation hosts what takes this one
   * queue: attach, detach, and switches, so none acts on a set another
   * changed while it waited.
   */
  let turn: Promise<unknown> = Promise.resolve();
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = turn.then(work);
    turn = next.catch(() => undefined);
    return next;
  }

  function refuseWhileStopping(): void {
    if (stopping) {
      throw new Error(
        "the Marbles process is stopping; retry once it has exited"
      );
    }
  }

  /** Ask `generation`, failing as soon as it exits. */
  function ask(
    generation: Generation,
    method: string,
    params?: unknown
  ): Promise<unknown> {
    const { channel } = generation;
    if (generation.exit !== undefined || !channel?.open) {
      return Promise.reject(
        new Error(
          `engine generation ${String(generation.number)} is gone${generation.exit ? `: ${generation.exit.why}` : ""}`
        )
      );
    }
    return Promise.race([
      channel.request(method, params),
      generation.exited.then(() => {
        throw new Error(
          `engine generation ${String(generation.number)} exited: ${generation.exit?.why ?? "unknown"}`
        );
      }),
    ]);
  }

  function spawnGeneration(
    number: number,
    fingerprint: Fingerprint
  ): Generation {
    const token = crypto.randomUUID();
    const child = spawn(
      runtime(),
      [...RUNTIME_FLAGS, script, "--socket", layout.socket, "--token", token],
      {
        cwd: layout.state,
        // A group of its own: a forced stop ends it and what it started.
        detached: true,
        // The generation keeps everything under this daemon's Foundry
        // home, and records there what it starts, for the next start to
        // recover.
        env: {
          ...process.env,
          FOUNDRY_HOME: layout.home,
          [SPAWN_RECOVERY_ENV]: layout.spawned,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const generation: Generation = {
      child,
      exited: Promise.resolve(),
      fingerprint,
      hosts: new Set(),
      number,
      registered: Promise.withResolvers<Channel>(),
      role: "candidate",
      tail: [],
      token,
    };
    generation.registered.promise.catch(() => undefined);
    const exited = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        const clean = code === 0;
        const why =
          generation.tail.length > 0 && !clean
            ? generation.tail.join("\n")
            : `exit ${code === null ? `signal ${String(signal)}` : String(code)}`;
        onExit(generation, { clean, why });
        resolve();
      });
      child.on("error", (error) => {
        // A child that never started has no pid and emits no `exit`.
        if (child.pid !== undefined) {
          print(`[generation ${String(number)}] ${error.message}`);
          return;
        }
        onExit(generation, {
          clean: false,
          why: `the generation did not start: ${error.message}`,
        });
        resolve();
      });
    });
    (generation as { exited: Promise<void> }).exited = exited;
    const prefix = `[generation ${String(number)}]`;
    child.stderr?.on(
      "data",
      lines((line) => {
        generation.tail.push(line);
        if (generation.tail.length > STDERR_TAIL) {
          generation.tail.shift();
        }
        print(`${prefix} ${line}`);
      })
    );
    child.stdout?.on(
      "data",
      lines((line) => print(`${prefix} ${line}`))
    );
    generations.add(generation);
    // Once the child is the daemon's; it never throws. Never a recovery
    // record: a generation whose daemon is gone drains its runs and exits.
    recordSpawned(child.pid, true, {
      ...process.env,
      [SPAWN_RECOVERY_ENV]: undefined,
    });
    return generation;
  }

  function onExit(
    generation: Generation,
    exit: { readonly clean: boolean; readonly why: string }
  ): void {
    if (generation.exit !== undefined) {
      return;
    }
    generation.exit = exit;
    generation.channel = undefined;
    generation.registered.reject(new Error(exit.why));
    generations.delete(generation);
    records
      .mark(
        generation.number,
        generation.role === "candidate" && !exit.clean ? "failed" : "exited",
        exit.clean ? undefined : exit.why
      )
      .catch((error: unknown) =>
        print(
          `[marbles] generation ${String(generation.number)}: ${message(error)}`
        )
      );
    if (closing !== undefined || stopping) {
      return;
    }
    if (generation === current) {
      onCurrentExit(generation, exit.why);
    } else if (generation.role === "retiring" && !exit.clean) {
      // Its runs and claims are a gone process's now: the next engine
      // start's recovery puts them right.
      print(
        `[marbles] retired engine generation ${String(generation.number)} died: ${exit.why}`
      );
      scheduleSwitch("a retired engine generation died", { force: true });
    }
  }

  /** The current generation is gone: its workspaces fail until another takes over. */
  function onCurrentExit(generation: Generation, why: string): void {
    current = undefined;
    print(
      `[marbles] engine generation ${String(generation.number)} exited: ${why}`
    );
    for (const id of generation.hosts) {
      const workspace = hosted.get(id);
      if (workspace !== undefined) {
        setState(workspace, "failed", { error: why });
      }
    }
    // A generation that keeps dying as it starts is left down, for a
    // change to its sources, or a reload, to bring back.
    if (Date.now() - (generation.since ?? 0) >= SETTLE_MS) {
      scheduleSwitch("the engine generation exited", { force: true });
    }
  }

  /** The generation spawned for `token` dialed in: bind its channel. */
  function register(token: string, channel: Channel): Generation {
    const generation = [...generations].find(
      (candidate) => candidate.token === token
    );
    if (generation === undefined) {
      throw new Error("no engine generation was spawned with this token");
    }
    generation.channel = channel;
    generation.registered.resolve(channel);
    return generation;
  }

  function onGenerationNotification(
    generation: Generation,
    method: string,
    params: unknown
  ): void {
    if (method !== GENERATION_NOTIFICATIONS.line) {
      return;
    }
    const parsed = lineParamsSchema.safeParse(params);
    if (!parsed.success) {
      return;
    }
    const { line, root } = parsed.data;
    if (root === undefined) {
      print(`[generation ${String(generation.number)}] ${line}`);
      return;
    }
    forwardLine(loadedId({ root }), line);
  }

  /**
   * End `generation`: ask it to drain and exit, and kill it and its
   * process group when it does not answer, or does not exit, in time.
   */
  async function stopGeneration(generation: Generation): Promise<void> {
    const { child, exited } = generation;
    if (generation.exit !== undefined) {
      return;
    }
    try {
      if (generation.channel?.open) {
        // It exits right after it answers; either is a clean stop.
        await timeout(
          Promise.race([
            generation.channel.request(GENERATION_METHODS.stop),
            exited,
          ]),
          STOP_TIMEOUT_MS,
          `stopping engine generation ${String(generation.number)}`
        );
      } else {
        // Not registered yet, so it holds nothing: end it now rather
        // than wait for it to come up.
        signalGroup(child, "SIGTERM");
      }
      await timeout(
        exited,
        STOP_TIMEOUT_MS,
        `engine generation ${String(generation.number)}'s exit`
      );
    } catch (error) {
      try {
        print(`[marbles] ${message(error)}; killing it`);
      } finally {
        // Killed even when saying so fails, with everything in its group.
        // SIGTERM would only ask it to drain again.
        signalGroup(child, "SIGKILL");
        await exited;
      }
    }
  }

  function summaryOf(record: WorkspaceRecord): Hosted {
    return {
      source: record.config ?? join(record.root, DEFAULT_SOURCE),
      summary: {
        config: record.config,
        id: record.id,
        root: record.root,
        state: "starting",
      },
    };
  }

  /** What would be loaded now, with the installation read again only every so often. */
  async function fingerprintNow(): Promise<Fingerprint> {
    if (Date.now() - installationAt >= INSTALLATION_POLL_MS) {
      installation = installationDigest(script);
      installationAt = Date.now();
    }
    const registered = (await registry.list()).filter((each) => each.hosted);
    return fingerprintOf(installation, sourceDigests(registered));
  }

  /**
   * The id a load reported, or the hosted workspace's at its root: a root
   * that is gone cannot be resolved to one.
   */
  function loadedId(load: WorkspaceLoadResult): string | undefined {
    return (
      load.id ??
      [...hosted.values()].find(
        (workspace) =>
          resolvePath(workspace.summary.root) === resolvePath(load.root)
      )?.summary.id
    );
  }

  /**
   * Bring up a new generation and make it current, as the module doc
   * says. Rejects, switching nothing, when the candidate does not load
   * every registered workspace while another generation is current.
   */
  function switchGenerations(
    reason: string,
    setups: Readonly<Record<string, SetupDraftParams>> = {},
    wanted: () => Promise<boolean> = () => Promise.resolve(true)
  ): Promise<void> {
    return inTurn(async () => {
      refuseWhileStopping();
      // Decided in the turn: a switch that ran while this one waited may
      // have loaded, or been refused, what it was asked for.
      if (await wanted()) {
        await runSwitch(reason, setups);
      }
    });
  }

  async function runSwitch(
    reason: string,
    setups: Readonly<Record<string, SetupDraftParams>>
  ): Promise<void> {
    const previous = current;
    const fingerprint = await announceSwitch(previous);
    // Numbered before its spawn, so a crash in between leaves a row.
    const number = await records.begin(fingerprint.digest);
    // In the same turn as the spawn: a close that began meanwhile has
    // stopped every generation it would see, and must not miss this one.
    refuseWhileStopping();
    const candidate = spawnGeneration(number, fingerprint);
    print(`[marbles] engine generation ${String(number)} starting: ${reason}`);
    if (candidate.child.pid !== undefined) {
      await records.spawned(number, candidate.child.pid);
    }
    let loaded: LoadResult;
    try {
      loaded = await loadCandidate(candidate, previous);
    } catch (error) {
      refused = fingerprint.digest;
      await refuse(candidate, previous, error);
      throw error;
    }
    if (previous !== undefined) {
      await retire(previous, loaded.identity);
    }
    let started: readonly WorkspaceLoadResult[];
    try {
      started = startResultSchema.parse(
        await timeout(
          ask(candidate, GENERATION_METHODS.start, { setups }),
          READY_TIMEOUT_MS,
          "starting the workspaces"
        )
      ).loads;
    } catch (error) {
      await refuse(candidate, undefined, error);
      throw error;
    }
    candidate.role = "current";
    candidate.since = Date.now();
    current = candidate;
    await records.mark(number, "current");
    showLoads(candidate, [
      ...started,
      ...loaded.loads.filter((each) => each.error !== undefined),
    ]);
    print(`[marbles] engine generation ${String(number)} is current`);
  }

  /**
   * List every registered workspace, show each the switch changes as
   * starting or reloading, and say what the candidate will load.
   */
  async function announceSwitch(
    previous: Generation | undefined
  ): Promise<Fingerprint> {
    const registered = (await registry.list()).filter((each) => each.hosted);
    installation = installationDigest(script);
    installationAt = Date.now();
    const fingerprint = fingerprintOf(installation, sourceDigests(registered));
    for (const record of registered) {
      const workspace = hosted.get(record.id) ?? summaryOf(record);
      hosted.set(record.id, workspace);
      const changed =
        previous?.fingerprint.sources.get(record.id) !==
        fingerprint.sources.get(record.id);
      if (previous === undefined || changed) {
        setState(
          workspace,
          previous?.hosts.has(record.id) ? "reloading" : "starting"
        );
      }
    }
    return fingerprint;
  }

  /**
   * The candidate registered and loaded every registered workspace, or
   * the reason it cannot take over: one did not load while `previous`
   * runs them.
   */
  async function loadCandidate(
    candidate: Generation,
    previous: Generation | undefined
  ): Promise<LoadResult> {
    await timeout(
      Promise.race([
        candidate.registered.promise,
        candidate.exited.then(() => {
          throw new Error(candidate.exit?.why ?? "it exited");
        }),
      ]),
      READY_TIMEOUT_MS,
      "starting the engine generation"
    );
    const loaded = loadResultSchema.parse(
      await timeout(
        ask(candidate, GENERATION_METHODS.load),
        READY_TIMEOUT_MS,
        "loading the workspaces"
      )
    );
    candidate.identity = loaded.identity;
    await records.identify(candidate.number, loaded.identity.started);
    const failed = loaded.loads.filter((load) => load.error !== undefined);
    if (previous !== undefined && failed.length > 0) {
      throw new CandidateError(failed);
    }
    return loaded;
  }

  /** `previous` hands what is not running to `successor`, and finishes the rest. */
  async function retire(
    previous: Generation,
    successor: ProcessIdentity
  ): Promise<void> {
    previous.role = "retiring";
    await records.mark(previous.number, "retiring");
    try {
      await timeout(
        ask(previous, GENERATION_METHODS.retire, { successor }),
        STOP_TIMEOUT_MS,
        `retiring engine generation ${String(previous.number)}`
      );
    } catch (error) {
      // One that cannot retire is stopped; what it held then is a gone
      // process's, which the candidate's start recovers.
      print(`[marbles] ${message(error)}; stopping it`);
      await stopGeneration(previous);
    }
  }

  /** Show each workspace as `generation`, now current, loaded it. */
  function showLoads(
    generation: Generation,
    loads: readonly WorkspaceLoadResult[]
  ): void {
    const pid = generation.child.pid ?? -1;
    for (const load of loads) {
      const id = loadedId(load);
      const workspace = id === undefined ? undefined : hosted.get(id);
      if (id === undefined || workspace === undefined) {
        continue;
      }
      if (load.error === undefined) {
        generation.hosts.add(id);
        workspace.setup = undefined;
        setState(workspace, "ready", { pid });
      } else {
        setState(workspace, "failed", { error: load.error });
      }
    }
  }

  /**
   * A candidate that did not come up: stopped, recorded failed, and each
   * workspace told why, the ones the current generation still runs left
   * running.
   */
  async function refuse(
    candidate: Generation,
    previous: Generation | undefined,
    error: unknown
  ): Promise<void> {
    const why = message(error);
    print(
      `[marbles] engine generation ${String(candidate.number)} did not take over: ${why}`
    );
    const failures =
      error instanceof CandidateError
        ? new Map(error.loads.map((load) => [loadedId(load), load.error]))
        : undefined;
    for (const workspace of hosted.values()) {
      const { id } = workspace.summary;
      const own = failures === undefined ? why : failures.get(id);
      if (previous?.hosts.has(id)) {
        // Still running as it was: ready, saying the change did not load.
        setState(workspace, "ready", {
          ...(own === undefined
            ? {}
            : {
                error: `a change did not load, so the previous load still runs: ${own}`,
              }),
        });
      } else if (
        workspace.summary.state === "starting" ||
        workspace.summary.state === "reloading"
      ) {
        setState(workspace, "failed", { error: own ?? why });
      }
    }
    await stopGeneration(candidate);
    await records.mark(candidate.number, "failed", why).catch(() => undefined);
  }

  /** A switch soon, once the edits that asked for it have settled. */
  function scheduleSwitch(
    reason: string,
    { force = false }: { readonly force?: boolean } = {}
  ): void {
    if (stopping) {
      return;
    }
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => {
      switchTimer = undefined;
      // Nothing new since the current generation loaded, or since a
      // candidate refused it: no switch, unless one is needed whatever
      // the sources say.
      const wanted = async (): Promise<boolean> => {
        if (force) {
          return true;
        }
        const now = await fingerprintNow();
        return (
          now.digest !== current?.fingerprint.digest && now.digest !== refused
        );
      };
      switchGenerations(reason, {}, wanted).catch((error: unknown) => {
        print(`[marbles] no switch: ${message(error)}`);
      });
    }, SWITCH_DEBOUNCE_MS);
  }

  /** Poll what the current generation loaded; a change asks for a switch. */
  let polling = false;
  const poll = setInterval(() => {
    if (polling || stopping || switchTimer !== undefined) {
      return;
    }
    polling = true;
    (async () => {
      const now = await fingerprintNow();
      const loaded = current?.fingerprint.digest;
      if (
        loaded !== undefined &&
        now.digest !== loaded &&
        now.digest !== refused
      ) {
        for (const [id, digest] of now.sources) {
          if (current?.fingerprint.sources.get(id) !== digest) {
            print(`[${id}] source changed · reloading`);
          }
        }
        scheduleSwitch("a source or the installation changed");
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, SOURCE_POLL_MS);
  poll.unref();

  /**
   * The workspace the source names, hosted: in the current generation at
   * once, or by a switch when none is current. A workspace hosted already
   * is answered from the same source only. A workspace that does not load
   * is listed failed, and not registered unless it was before.
   */
  function attach(
    source: string,
    setup?: SetupDraftParams,
    root?: string
  ): Promise<WorkspaceSummary> {
    // The client resolved the source; the daemon's own directory names nothing.
    if (!isAbsolute(source)) {
      return Promise.reject(
        new Error(`the source to attach must be absolute, not "${source}"`)
      );
    }
    const configPath = resolveSource(source, root ?? dirname(source));
    const found = sourceFiles(configPath) !== undefined;
    const placed = found ? sourceRoot(configPath) : root;
    if (placed === undefined) {
      return Promise.reject(
        new Error(
          `nothing is at ${configPath}, and no workspace root was given to register instead`
        )
      );
    }
    const workspace = layout.workspace(placed);
    const config = found ? configPath : null;
    return inTurn(async () => {
      refuseWhileStopping();
      // Its runs and sessions would be written through the link.
      if (!insideState(layout.state, workspace.id)) {
        throw new Error(
          `the state of workspace ${workspace.id} at ${workspace.dir} links out of the state root; it is not hosted`
        );
      }
      const existing = hosted.get(workspace.id);
      if (existing !== undefined && existing.summary.state !== "stopped") {
        const again = await attachAgain(existing, configPath, setup);
        if (again !== undefined) {
          return again;
        }
      }
      return await hostNew(workspace, config, configPath, setup);
    });
  }

  /**
   * An attach of a workspace listed already: from the same source only,
   * answered as it is unless it failed or brings a starter, which load it
   * afresh. `undefined` when it is to be hosted as a new one.
   */
  async function attachAgain(
    existing: Hosted,
    configPath: string,
    setup: SetupDraftParams | undefined
  ): Promise<WorkspaceSummary | undefined> {
    const { id } = existing.summary;
    if (existing.source !== configPath) {
      throw new Error(
        `workspace ${id} is hosted from ${existing.source}; detach it first`
      );
    }
    if (setup === undefined && existing.summary.state !== "failed") {
      return existing.summary;
    }
    if (!(current?.hosts.has(id) || setup !== undefined)) {
      return;
    }
    // A fresh load of it, with its starter's milestone to post.
    await runSwitch(
      `workspace ${id} attached again`,
      setup === undefined ? {} : { [id]: setup }
    );
    return existing.summary;
  }

  /** Register a workspace and host it: in the current generation, or by a switch. */
  async function hostNew(
    workspace: Workspace,
    config: string | null,
    configPath: string,
    setup: SetupDraftParams | undefined
  ): Promise<WorkspaceSummary> {
    const before = await registry.read(workspace.id);
    await registry.touch(workspace, config, { hosted: true });
    const entry: Hosted = {
      ...(setup === undefined ? {} : { setup }),
      source: configPath,
      summary: {
        config,
        id: workspace.id,
        root: workspace.root,
        state: "starting",
      },
    };
    hosted.set(workspace.id, entry);
    publish(entry);
    const target = current;
    if (target === undefined) {
      await runSwitch(
        `workspace ${workspace.id} attached`,
        setup === undefined ? {} : { [workspace.id]: setup }
      );
      if (entry.summary.state === "failed") {
        throw new Error(entry.summary.error ?? "the workspace did not load");
      }
      return entry.summary;
    }
    try {
      hostResultSchema.parse(
        await timeout(
          ask(target, GENERATION_METHODS.host, {
            config,
            root: workspace.root,
            ...(setup === undefined ? {} : { setup }),
          }),
          READY_TIMEOUT_MS,
          "starting the workspace"
        )
      );
    } catch (error) {
      // Not registered unless it was: it must not keep every later
      // generation from loading cleanly.
      if (before?.hosted !== true) {
        await registry.unhost(workspace.id);
      }
      setState(entry, "failed", { error: message(error) });
      throw error;
    }
    target.hosts.add(workspace.id);
    entry.setup = undefined;
    setState(entry, "ready", { pid: target.child.pid ?? -1 });
    return entry.summary;
  }

  function knownWorkspace(id: string): Hosted {
    const workspace = hosted.get(id);
    if (workspace === undefined) {
      throw new Error(`no workspace "${id}" is hosted`);
    }
    return workspace;
  }

  /**
   * Stop hosting workspace `id`: its running work in the current
   * generation finishes, then it closes there, and it is recorded as not
   * hosted. A detach that finds it gone already has nothing to do.
   */
  function detach(id: string): Promise<void> {
    return inTurn(async () => {
      const workspace = hosted.get(id);
      if (workspace === undefined) {
        return;
      }
      const target = current;
      if (target?.hosts.has(id)) {
        await ask(target, GENERATION_METHODS.unhost, { id });
        target.hosts.delete(id);
      }
      // The record first: a write that fails leaves it listed, so the
      // detach can be retried, rather than hosted again at the next boot.
      await registry.unhost(id);
      hosted.delete(id);
      setState(workspace, "stopped");
    });
  }

  /**
   * What a stopping daemon refuses: anything that would start a
   * generation or start work in one. Reading, answering, cancelling, and
   * pausing stay open, so a drain that waits on a run can still be cut
   * short.
   */
  function startsWork(method: string, params: unknown): boolean {
    if (method === `${WORKSPACE_PREFIX}${WORKSPACE_METHODS.tasks}`) {
      const { command } = workspaceIdSchema.passthrough().parse(params);
      return (
        typeof command === "object" &&
        command !== null &&
        "kind" in command &&
        command.kind === "change"
      );
    }
    return (
      method === DAEMON_METHODS.attach ||
      method === DAEMON_METHODS.reload ||
      (method.startsWith(WORKSPACE_PREFIX) &&
        DISPATCHING.has(method.slice(WORKSPACE_PREFIX.length)))
    );
  }

  /** The live generations hosting workspace `id`, the current one first, then newest first. */
  function hostsOf(id: string): Generation[] {
    return [...generations]
      .filter(
        (generation) =>
          generation.role !== "candidate" &&
          generation.exit === undefined &&
          generation.hosts.has(id)
      )
      .sort((a, b) => {
        if (a === current) {
          return -1;
        }
        if (b === current) {
          return 1;
        }
        return b.number - a.number;
      });
  }

  /** The generation that owns run `runId` of workspace `id`: its run's owner's. */
  async function ownerOf(
    id: string,
    runId: unknown
  ): Promise<Generation | undefined> {
    if (typeof runId !== "string") {
      return;
    }
    const run = await readExecution(database.database, id, runId).catch(
      () => null
    );
    if (run === null) {
      return;
    }
    return hostsOf(id).find(
      (generation) =>
        generation.identity !== undefined &&
        sameProcess(generation.identity, {
          pid: run.owner.pid,
          started: run.owner.started ?? null,
        })
    );
  }

  /**
   * Ask each generation in turn until one answers: a question is held by
   * whichever generation runs, or adopted, the run that asked, and the
   * others refuse it, changing nothing. Rejects as the first did.
   */
  async function askEach(
    hosts: readonly Generation[],
    method: string,
    params: unknown
  ): Promise<unknown> {
    const errors: unknown[] = [];
    for (const generation of hosts) {
      try {
        return await ask(generation, method, params);
      } catch (error) {
        errors.push(error);
      }
    }
    throw errors[0];
  }

  async function workspaceCall(
    id: string,
    name: string,
    rest: Record<string, unknown>
  ): Promise<unknown> {
    const workspace = knownWorkspace(id);
    if (!isWorkspaceMethod(name)) {
      throw new Error(`no workspace method "${name}"`);
    }
    const method = `${WORKSPACE_PREFIX}${name}`;
    const params = { ...rest, id };
    const hosts = hostsOf(id);
    if (RUN_METHODS.has(name)) {
      const owner = await ownerOf(id, rest.runId);
      if (owner !== undefined) {
        return await ask(owner, method, params);
      }
    }
    if (name === WORKSPACE_METHODS.answer && hosts.length > 1) {
      return await askEach(hosts, method, params);
    }
    const target = current;
    if (
      target === undefined ||
      !target.hosts.has(id) ||
      workspace.summary.state === "failed" ||
      workspace.summary.state === "starting" ||
      workspace.summary.state === "stopped"
    ) {
      throw new Error(
        `workspace ${id} is ${workspace.summary.state}${workspace.summary.error ? `: ${workspace.summary.error}` : ""}`
      );
    }
    return await ask(target, method, params);
  }

  async function answer(
    client: Client,
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (stopping && startsWork(method, params)) {
      throw new Error(
        "the Marbles process is stopping; retry once it has exited"
      );
    }
    switch (method) {
      case DAEMON_METHODS.hello:
        return hello;
      case DAEMON_METHODS.workspaces:
        return [...hosted.values()].map((workspace) => workspace.summary);
      case DAEMON_METHODS.attach: {
        const { root, setup, source } = attachParamsSchema.parse(params);
        return await timeout(
          attach(source, setup, root),
          READY_TIMEOUT_MS,
          "starting the workspace"
        );
      }
      case DAEMON_METHODS.reload: {
        const { id } = workspaceIdSchema.parse(params);
        const workspace = knownWorkspace(id);
        await timeout(
          switchGenerations(`workspace ${id} reloaded`),
          READY_TIMEOUT_MS,
          "reloading the workspace"
        );
        return workspace.summary;
      }
      case DAEMON_METHODS.detach: {
        const { id } = workspaceIdSchema.parse(params);
        knownWorkspace(id);
        await detach(id);
        return undefined;
      }
      case DAEMON_METHODS.subscribe: {
        const { id } = workspaceIdSchema.parse(params);
        client.subscriptions.add(id);
        return undefined;
      }
      case DAEMON_METHODS.unsubscribe: {
        const { id } = workspaceIdSchema.parse(params);
        client.subscriptions.delete(id);
        return undefined;
      }
      case DAEMON_METHODS.shutdown:
        // Refuse new work at once; the reply goes out before the drain starts.
        stopping = true;
        setImmediate(() => {
          close().catch(() => undefined);
        });
        return undefined;
      default:
        break;
    }
    if (method.startsWith(WORKSPACE_PREFIX)) {
      const { id, ...rest } = workspaceIdSchema.passthrough().parse(params);
      return await workspaceCall(
        id,
        method.slice(WORKSPACE_PREFIX.length),
        rest
      );
    }
    throw new Error(`no method "${method}"`);
  }

  /**
   * A connection is a client until it registers as a generation; from then
   * on its notifications are the generation's and its requests are refused.
   */
  function onConnection(socket: Socket): void {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let generation: Generation | undefined;
    const client: Client = {
      channel: new Channel(socketTransport(socket), {
        notification(method, params) {
          if (generation?.channel === client.channel) {
            onGenerationNotification(generation, method, params);
          }
        },
        request(method, params) {
          if (generation) {
            return Promise.reject(new Error("a generation only notifies"));
          }
          if (method === DAEMON_METHODS.register) {
            const { token } = registerParamsSchema.parse(params);
            generation = register(token, client.channel);
            clients.delete(client);
            return Promise.resolve();
          }
          return answer(client, method, params);
        },
      }),
      subscriptions: new Set(),
    };
    clients.add(client);
    client.channel.closed
      .then((reason) => {
        clients.delete(client);
        // A clean hang-up is routine; a failed connection is worth a line,
        // since it is the one thing that used to end this process.
        if (reason !== undefined) {
          print(
            generation === undefined
              ? `[marbles] a client's connection failed: ${reason.message}`
              : `[generation ${String(generation.number)}] its connection failed: ${reason.message}`
          );
        }
      })
      .catch(() => undefined);
  }

  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server: Server = createServer(onConnection);

  // The claim is the daemon's reason to run: a state root that was removed,
  // or a lock someone else now holds, means this process answers for nothing.
  const claimCheck = setInterval(() => {
    if (!holdsLock(join(layout.state, "locks", "process"))) {
      print("[marbles] the claim at the state root is gone; stopping");
      close({ claimLost: true }).catch(() => undefined);
    }
  }, CLAIM_CHECK_MS);
  claimCheck.unref();

  // From here on a failure is a shutdown: whatever started is stopped, the
  // server closed, the database closed, and the claim released, in that
  // order, as `close` does.
  try {
    if (existsSync(layout.socket)) {
      // We hold the lock, so whoever listened here is gone.
      rmSync(layout.socket, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(layout.socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // Whoever can connect can run workflows and agents as this user.
    chmodSync(layout.socket, 0o600);
    print(`[marbles] pid ${String(process.pid)} · ${layout.socket}`);
    // What an earlier Marbles process left recorded live died with it.
    await records.endAll();
    const registered = (await registry.list()).filter((each) => each.hosted);
    if (registered.length > 0) {
      for (const record of registered) {
        hosted.set(record.id, summaryOf(record));
      }
      // Every registered workspace is hosted again; one that does not load
      // is reported failed, and the rest run.
      switchGenerations("the Marbles process started").catch(
        (error: unknown) => {
          print(`[marbles] not hosted again: ${message(error)}`);
        }
      );
    }
  } catch (error) {
    // The startup error is the one thrown; a cleanup that fails too is not.
    await close().catch(() => undefined);
    throw error;
  }

  /**
   * Stop everything, in order: the generations, the clients and their
   * sockets, the server and its socket, the database, the claim. Each step
   * is attempted whatever an earlier one threw, so a failing step, or a
   * `print` that throws, cannot leave the database open or the claim held;
   * the first error is the one `close` rejects with.
   */
  function close({ claimLost = false } = {}): Promise<void> {
    closing ??= (async () => {
      stopping = true;
      clearInterval(claimCheck);
      clearInterval(poll);
      clearTimeout(switchTimer);
      // Every step runs whatever an earlier one threw; the first error wins.
      let failure: { readonly error: unknown } | undefined;
      const attempt = async (step: () => unknown): Promise<void> => {
        try {
          await step();
        } catch (error) {
          failure ??= { error };
        }
      };
      await attempt(() => print("[marbles] stopping"));
      await attempt(() =>
        everyOf([...generations], (generation) => stopGeneration(generation))
      );
      await attempt(() => {
        for (const workspace of hosted.values()) {
          setState(workspace, "stopped");
        }
      });
      await attempt(() =>
        everyOf([...clients], (client) => client.channel.close())
      );
      // `server.close` waits for every connection; a generation that would
      // not stop, or a client that never hung up, must not hold the exit.
      await attempt(() => everyOf([...sockets], (socket) => socket.destroy()));
      if (claimLost) {
        // Whoever holds the claim now may listen at this path, and closing
        // the server unlinks the socket by name (Bun, and libuv under Node).
        // Leave both alone; the process exits around the listener.
        await attempt(() => server.unref());
      } else {
        // A server that never listened answers at once, with an error.
        await attempt(
          () => new Promise<void>((resolve) => server.close(() => resolve()))
        );
        await attempt(() => rmSync(layout.socket, { force: true }));
      }
      await attempt(() => database.close());
      await attempt(() => claim.release());
      resolveClosed();
      if (failure !== undefined) {
        throw failure.error;
      }
    })();
    return closing;
  }

  return {
    close: () => close(),
    closed,
    pid: process.pid,
    socket: layout.socket,
  };
}

/** A candidate generation that did not load every registered workspace. */
class CandidateError extends Error {
  override readonly name = "CandidateError";
  readonly loads: readonly WorkspaceLoadResult[];

  constructor(loads: readonly WorkspaceLoadResult[]) {
    super(
      loads
        .map(
          (load) => load.error ?? `the workspace at ${load.root} did not load`
        )
        .join("; ")
    );
    this.loads = loads;
  }
}
