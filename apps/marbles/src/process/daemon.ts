import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { holdsLock } from "@foundry/lib/file-lock";
import {
  compareStarts,
  isGone,
  lookProcesses,
  type ProcessIdentity,
  sameProcess,
  startedAt as startOf,
} from "@foundry/lib/process-identity";
import { readExecution } from "~/database/executions";
import { GenerationRecords } from "~/database/generations";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { unheldParkedRuns } from "~/database/runs";
import { WorkspaceRegistry } from "~/database/workspaces";
import type { Layout } from "~/layout";
import {
  insideState,
  type Workspace,
  type WorkspaceRecord,
} from "~/lib/state/workspace";
import type { WorkspaceSummary } from "~/model/connection";
import { Channel, socketTransport } from "~/process/channel";
import {
  differences,
  FileDigests,
  type Fingerprint,
  fingerprintOf,
  installationDigest,
  printNow,
  type WorkspacePrint,
  withRead,
} from "~/process/fingerprint";
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
  readParamsSchema,
  registerParamsSchema,
  releasedParamsSchema,
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

/** The timers a daemon schedules its switches with; the system's when omitted. */
export interface DaemonClock {
  clearTimeout(handle: unknown): void;
  setTimeout(work: () => void, ms: number): unknown;
}

export interface DaemonOptions {
  /** The timers switches are scheduled with: their debounce and the replacement backoff. */
  readonly clock?: DaemonClock;
  /** The generation entry to spawn; the one beside this module when omitted. */
  readonly generationEntry?: string;
  readonly layout: Layout;
  readonly print?: (line: string) => void;
}

export interface Daemon {
  close(): Promise<void>;
  readonly closed: Promise<void>;
  /**
   * Resolves once no switch is running, with whether one is scheduled on
   * the clock and why: each exit, or each file whose change, asked for
   * it. For a caller that waits for the daemon to be still.
   */
  idle(): Promise<{
    readonly reasons: readonly string[];
    readonly scheduled: boolean;
  }>;
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
/**
 * How long the daemon waits before it replaces a generation that died, or
 * one that did not start after the previous one retired: from the least,
 * doubled after each replacement, up to the most, and back to the least
 * once a generation has stayed current for `STABLE_MS`.
 */
const REPLACE_MIN_MS = 1000;
const REPLACE_MAX_MS = 30_000;
const STABLE_MS = 30_000;
/** How many times a released run is offered to the current generation, and how long between. */
const HANDOVER_ATTEMPTS = 5;
const HANDOVER_RETRY_MS = 200;
/** How often the parked runs no live engine holds are offered to the current generation. */
const SWEEP_MS = 2000;
/** How long a run the current generation declined waits before it is offered again. */
const REOFFER_MS = 30_000;
/** How long an answer to a question on its way to another generation waits for it to arrive. */
const HELD_WAIT_MS = 30_000;
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
  fingerprint: Fingerprint;
  /** The workspaces it hosts, by id. */
  readonly hosts: Set<string>;
  /** Its process, as it reported it once it loaded. */
  identity?: ProcessIdentity;
  readonly number: number;
  readonly registered: PromiseWithResolvers<Channel>;
  role: "candidate" | "current" | "retiring";
  /** When it became current. */
  since?: number;
  /**
   * Its process as read right after the spawn, the proof every signal the
   * daemon sends it checks first; its start is null when it could not be
   * read then.
   */
  readonly spawnedAs: ProcessIdentity | undefined;
  /** Settles once its engines have started, or failed to. */
  readonly started: PromiseWithResolvers<void>;
  /** Last lines of stderr, for a failure's explanation. */
  readonly tail: string[];
  readonly token: string;
}

/** A workspace the Marbles process hosts, as clients see it. */
interface Hosted {
  /**
   * Set while it is being detached: its generations drain it, its runs
   * stay reachable, and no new work or attach of it is let in.
   */
  detaching?: Promise<void>;
  /** Handed to the generation that next starts it: it posts the setup milestone. */
  setup?: SetupDraftParams;
  /** Where its source is, or would be. */
  readonly source: string;
  summary: WorkspaceSummary;
}

interface Client {
  readonly channel: Channel;
  readonly subscriptions: Set<string>;
}

/**
 * Where each workspace method goes, by what it names:
 *
 * - A run (`RUN_METHODS`: cancel, cancelRun, getRun, pause, resume,
 *   steer): the generation whose process owns its Execution Run, else the
 *   current one when its owner is gone; one owned by a live process that
 *   is no generation of this daemon is refused, but for a read.
 * - A question or an activity (`HELD_METHODS`: answer, stopActivity): the
 *   generation that holds its live run or session, found by asking each
 *   in turn, the current one first; one that does not hold it refuses,
 *   changing nothing.
 * - Anything else starts new work or reads what the database keeps
 *   (describe, snapshot, launch, roll, dispatchAgent, dispatchWorkflow,
 *   deleteTrigger, setTriggerEnabled, tasks): the current generation.
 */

/** Workspace methods about one run: answered by the generation that runs it. */
const RUN_METHODS = new Set<string>([
  WORKSPACE_METHODS.cancel,
  WORKSPACE_METHODS.cancelRun,
  WORKSPACE_METHODS.getRun,
  WORKSPACE_METHODS.pause,
  WORKSPACE_METHODS.resume,
  WORKSPACE_METHODS.steer,
]);

/** Workspace methods about what one live run or session holds. */
const HELD_METHODS = new Set<string>([
  WORKSPACE_METHODS.answer,
  WORKSPACE_METHODS.stopActivity,
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

/** What `askOwner` answers when no generation of this daemon owns the run. */
const NO_OWNER_HERE: unique symbol = Symbol("no generation here owns the run");

/** Whether `error` says a question is on its way to another generation with its run. */
function isMoving(error: unknown): boolean {
  return error instanceof Error && MOVING_ERRORS.has(error.name);
}

/**
 * What an engine refuses with when the work belongs to the next generation:
 * a question moving with its run, or a launch that reached an engine that
 * has begun to retire.
 */
const MOVING_ERRORS = new Set(["QuestionMovingError", "EngineRetiringError"]);

/** Resolves once `generation` has started, or failed to; at once without one. */
function settledStart(generation: Generation | undefined): Promise<void> {
  return (
    generation?.started.promise.then(
      () => undefined,
      () => undefined
    ) ?? Promise.resolve()
  );
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
  let hostsWritten: Promise<void> = Promise.resolve();
  /** Generations whose hosts are still to be written (`recordHosts`). */
  const hostsDue = new Set<Generation>();
  /** The retry of a hosts write that failed, while one is due. */
  let hostsTimer: unknown;
  let hostsDelay = REPLACE_MIN_MS;
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
  /**
   * The fingerprint of the last candidate that did not load, as it read
   * what it read: not tried again on its own while nothing it covers
   * changes.
   */
  let refused: Fingerprint | undefined;
  /** Content digests of the files fingerprints cover, each read again only once it changed. */
  const digests = new FileDigests();
  /**
   * What no workspace tree covers: the Foundry home, which may sit inside
   * a workspace's root, and whose database changes as Marbles runs. Both
   * its spellings, as given and resolved through links.
   */
  const ignored = new Set(
    [layout.home, layout.state, layout.artifacts].flatMap((path) => {
      const resolved = resolvePath(path);
      try {
        return [resolved, realpathSync(resolved)];
      } catch {
        return [resolved];
      }
    })
  );
  let installation = installationDigest(script, version);
  let installationAt = Date.now();
  const clock: DaemonClock = options.clock ?? {
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    setTimeout: (work, ms) => setTimeout(work, ms),
  };
  let switchTimer: unknown;
  /** Whether the switch `switchTimer` starts must run whatever the sources say. */
  let switchForced = false;
  /** Why the switch `switchTimer` starts was asked for, each ask a line. */
  const switchReasons: string[] = [];
  /**
   * Set while a switch runs: what is current is being decided, so the
   * poll asks for nothing until it is, and then compares with that.
   */
  let switchRunning = false;
  /** How long the next replacement of a dead generation waits. */
  let replaceDelay = REPLACE_MIN_MS;

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
      spawnedAs:
        child.pid === undefined
          ? undefined
          : { pid: child.pid, started: startOf(child.pid) ?? null },
      started: Promise.withResolvers<void>(),
      tail: [],
      token,
    };
    generation.registered.promise.catch(() => undefined);
    generation.started.promise.catch(() => undefined);
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
    generation.started.reject(new Error(exit.why));
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
    // Only the current generation's exit is reason to replace it: a
    // retired one leaves, cleanly or not, after the next took over.
    if (generation === current && generation.role !== "retiring") {
      onCurrentExit(generation, exit.why);
    } else if (generation.role === "retiring" && !exit.clean) {
      // Its runs and claims are a gone process's now: the next engine
      // start's recovery puts them right.
      print(
        `[marbles] retired engine generation ${String(generation.number)} died: ${exit.why}`
      );
      scheduleSwitch("a retired engine generation died", {
        because: [
          `retired engine generation ${String(generation.number)} exited uncleanly: ${exit.why}`,
        ],
        force: true,
      });
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
    replaceCurrent("the engine generation exited", generation, [
      `current engine generation ${String(generation.number)} exited: ${why}`,
    ]);
  }

  /**
   * With none current, start the next generation, whatever the sources
   * say, after the replacement backoff: the next engine start recovers
   * what the last one left. `died` is the generation that was current,
   * when one died; one that stayed up long enough resets the backoff.
   */
  function replaceCurrent(
    reason: string,
    died?: Generation,
    because: readonly string[] = [reason]
  ): void {
    if (died?.since !== undefined && Date.now() - died.since >= STABLE_MS) {
      replaceDelay = REPLACE_MIN_MS;
    }
    const delay = replaceDelay;
    replaceDelay = Math.min(replaceDelay * 2, REPLACE_MAX_MS);
    print(
      `[marbles] ${reason}; the next engine generation starts in ${String(delay)}ms`
    );
    scheduleSwitch(reason, { because, delayMs: delay, force: true });
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
    if (method === GENERATION_NOTIFICATIONS.read) {
      const parsed = readParamsSchema.safeParse(params);
      if (parsed.success) {
        readBy(
          generation,
          parsed.data.root,
          parsed.data.file,
          parsed.data.readAt
        );
      }
      return;
    }
    if (method === GENERATION_NOTIFICATIONS.released) {
      const parsed = releasedParamsSchema.safeParse(params);
      if (parsed.success) {
        handOver(parsed.data.id, parsed.data.runId).catch(() => undefined);
      }
      return;
    }
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

  /** Each workspace's handovers of released runs, one after another. */
  const handovers = new Map<string, Promise<void>>();
  /** The handover of each run under way, by workspace id and run id: one offer at a time. */
  const offering = new Map<string, Promise<void>>();
  /** When the current generation last declined each run offered, by workspace id and run id. */
  const declined = new Map<string, number>();
  /** Who waits for a workspace's next handover or switch, by workspace id. */
  const waiting = new Map<string, Set<() => void>>();

  /** Wake whoever waits on workspace `id`, or on every one. */
  function changed(id?: string): void {
    for (const [key, wakers] of waiting) {
      if (id === undefined || key === id) {
        waiting.delete(key);
        for (const wake of wakers) {
          wake();
        }
      }
    }
  }

  /** Resolves at the next handover or switch for workspace `id`, or after `ms`. */
  function nextChange(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const wakers = waiting.get(id) ?? new Set();
      wakers.add(() => {
        clearTimeout(timer);
        resolve();
      });
      waiting.set(id, wakers);
    });
  }

  /**
   * Offer parked run `runId` of workspace `id`, which no live engine holds,
   * to the current generation, after the workspace's handovers before it:
   * one a retired generation let go (`released`), or one the sweep found.
   * A Run whose park is still being written is offered again a few times;
   * one the current generation does not take is offered by the sweep
   * again later. Resolves once it is settled either way.
   */
  function handOver(id: string, runId: string): Promise<void> {
    const key = `${id}\0${runId}`;
    const pending = offering.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const previous = handovers.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      for (let attempt = 0; attempt < HANDOVER_ATTEMPTS; attempt += 1) {
        // Read in each turn: a switch may have made another current.
        const target = current;
        await settledStart(target);
        if (
          target === undefined ||
          target !== current ||
          !target.hosts.has(id)
        ) {
          return;
        }
        try {
          if (
            (await ask(target, GENERATION_METHODS.adopt, { id, runId })) ===
            true
          ) {
            declined.delete(key);
            return;
          }
        } catch (error) {
          print(`[${id}] run ${runId} not taken over: ${message(error)}`);
          break;
        }
        await nextChange(id, HANDOVER_RETRY_MS);
      }
      declined.set(key, Date.now());
    });
    const done = next.finally(() => {
      offering.delete(key);
      if (handovers.get(id) === done) {
        handovers.delete(id);
      }
      changed(id);
    });
    offering.set(key, done);
    handovers.set(id, done);
    return done;
  }

  /**
   * Offer the current generation every parked run of `ids` (every
   * workspace it hosts when omitted) that no live engine holds, as the
   * Marbles database has it: what a retired generation let go whose
   * notice was lost, or that an adoption gave back. One the current
   * generation declined is offered again only after `REOFFER_MS`, unless
   * `now`. Resolves once each offer has settled.
   */
  async function sweep(
    ids: Iterable<string> | undefined,
    { now = false }: { readonly now?: boolean } = {}
  ): Promise<void> {
    const target = current;
    if (target === undefined || stopping) {
      return;
    }
    const offers: Promise<void>[] = [];
    for (const id of ids ?? target.hosts) {
      let parked: readonly string[];
      try {
        parked = await unheldParkedRuns(database.database, id);
      } catch {
        continue;
      }
      for (const runId of parked) {
        const at = declined.get(`${id}\0${runId}`);
        if (now || at === undefined || Date.now() - at >= REOFFER_MS) {
          offers.push(handOver(id, runId));
        }
      }
    }
    await Promise.all(offers);
  }

  /**
   * End `generation`: ask it to drain and exit, and kill it and its
   * process group when it does not answer, or does not exit, in time.
   */
  async function stopGeneration(generation: Generation): Promise<void> {
    const { exited } = generation;
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
      } else if (signalProven(generation, "SIGTERM")) {
        // Not registered yet, so it holds nothing: end it now rather
        // than wait for it to come up.
      } else {
        return;
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
        // SIGTERM would only ask it to drain again. One that cannot be
        // proved to be it is left, and not waited on.
        if (signalProven(generation, "SIGKILL")) {
          await exited;
        }
      }
    }
  }

  /**
   * Send `signal` to `generation`, and to its process group when it leads
   * one, only once its pid is proved to be the process the daemon spawned:
   * running, and started when it was read to have started right after the
   * spawn (or, when that could not be read, when the generation said it
   * did). Whether it was sent; a process that is gone already, or cannot
   * be proved to be the generation, is not signalled, and the second is
   * said.
   */
  function signalProven(
    generation: Generation,
    signal: NodeJS.Signals
  ): boolean {
    const known =
      generation.spawnedAs?.started === null
        ? generation.identity
        : generation.spawnedAs;
    const label = `engine generation ${String(generation.number)}`;
    if (generation.exit !== undefined) {
      return false;
    }
    if (known === undefined || known.started === null) {
      print(
        `[marbles] ${label} is not sent ${signal}: its start was never read, so its pid cannot be proved to be it`
      );
      return false;
    }
    const seen = lookProcesses([known.pid]);
    if (seen === undefined) {
      print(
        `[marbles] ${label} is not sent ${signal}: the system cannot say what runs as pid ${String(known.pid)}`
      );
      return false;
    }
    const running = seen.get(known.pid);
    if (running === undefined) {
      return false;
    }
    if (compareStarts(running.started, known.started) !== "same") {
      print(
        `[marbles] ${label} is not sent ${signal}: pid ${String(known.pid)} is another process now`
      );
      return false;
    }
    try {
      process.kill(running.pgid === known.pid ? -known.pid : known.pid, signal);
    } catch {
      return false;
    }
    return true;
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

  /**
   * What every registered workspace is now, over the files outside its
   * root that `against` covers: the fingerprint `against` would be if it
   * were taken now. The installation is read again only every so often.
   */
  async function fingerprintNow(against?: Fingerprint): Promise<Fingerprint> {
    if (Date.now() - installationAt >= INSTALLATION_POLL_MS) {
      installation = installationDigest(script, version);
      installationAt = Date.now();
    }
    const registered = (await registry.list()).filter((each) => each.hosted);
    const sources = new Map<string, WorkspacePrint>();
    for (const record of registered) {
      const outside = against?.sources.get(record.id)?.outside.keys() ?? [];
      sources.set(record.id, printNow(record, outside, digests, ignored));
    }
    return fingerprintOf(installation, sources);
  }

  /** Whether nothing `fingerprint` covers changed since it was taken. */
  async function unchanged(fingerprint: Fingerprint): Promise<boolean> {
    return (await fingerprintNow(fingerprint)).digest === fingerprint.digest;
  }

  /** `fingerprint` with workspace `id`'s part `print`, or without it. */
  function withSource(
    fingerprint: Fingerprint,
    id: string,
    part: WorkspacePrint | undefined
  ): Fingerprint {
    const sources = new Map(fingerprint.sources);
    if (part === undefined) {
      sources.delete(id);
    } else {
      sources.set(id, part);
    }
    return fingerprintOf(fingerprint.installation, sources);
  }

  /**
   * `generation` read `file` at `readAt` for the workspace at `root`: its
   * fingerprint records it, as it was when read when it has not changed
   * since, else as changed, so the next poll starts the next generation.
   */
  function readBy(
    generation: Generation,
    root: string,
    file: string,
    readAt: number
  ): void {
    const id = loadedId({ root });
    const workspace = id === undefined ? undefined : hosted.get(id);
    const part =
      id === undefined ? undefined : generation.fingerprint.sources.get(id);
    if (id === undefined || workspace === undefined || part === undefined) {
      return;
    }
    const next = withRead(part, file, readAt, digests);
    if (next !== part) {
      generation.fingerprint = withSource(generation.fingerprint, id, next);
    }
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
    switchRunning = true;
    try {
      await switchOnce(reason, setups);
    } finally {
      switchRunning = false;
    }
  }

  async function switchOnce(
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
      // As it read what it read: a fix to any of it is a reason to try again.
      refused = candidate.fingerprint;
      await refuse(candidate, previous, error);
      throw error;
    }
    // The candidate is current from here, before the previous one is told
    // to go: that one's exit, however soon, is then no reason to replace
    // anything. Calls for its workspaces wait for its start.
    current = candidate;
    candidate.role = "current";
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
      candidate.started.reject(error);
      // Its exit may have said so first: only one of them replaces it.
      const replacing = current === candidate;
      if (replacing) {
        current = undefined;
      }
      await refuse(candidate, undefined, error);
      if (replacing) {
        // The previous one retired already: nothing is current now, so
        // the next generation starts as after a crash, and recovers what
        // this one may have taken over before it failed.
        replaceCurrent("the engine generation did not start");
      }
      throw error;
    }
    candidate.since = Date.now();
    await records.mark(number, "current");
    // It died while that was written: its exit has replaced it already.
    if (candidate.exit !== undefined || current !== candidate) {
      return;
    }
    showLoads(candidate, [
      ...started,
      ...loaded.loads.filter((each) => each.error !== undefined),
    ]);
    candidate.started.resolve();
    print(`[marbles] engine generation ${String(number)} is current`);
    changed();
    // A workspace whose engine did not start loaded, so no edit will bring
    // it back: it is current for the rest, and the next generation starts
    // after the replacement backoff, until one starts every workspace.
    const notStarted = started.filter((load) => load.error !== undefined);
    if (notStarted.length > 0) {
      replaceCurrent(
        "a workspace's engine did not start",
        undefined,
        notStarted.map(
          (load) =>
            `workspace ${loadedId(load) ?? load.root} did not start in engine generation ${String(number)}: ${load.error ?? "unknown"}`
        )
      );
    }
    // Last: everything above runs in the turn the liveness check passed.
    await recordHosts(candidate);
  }

  /**
   * List every registered workspace, show each the switch changes as
   * starting or reloading, and say what the candidate will load.
   */
  async function announceSwitch(
    previous: Generation | undefined
  ): Promise<Fingerprint> {
    installation = installationDigest(script, version);
    installationAt = Date.now();
    // Taken before the candidate loads anything: what it reads outside a
    // workspace's root is added as it says it read it.
    const fingerprint = await fingerprintNow();
    const before =
      previous === undefined
        ? undefined
        : await fingerprintNow(previous.fingerprint);
    const registered = (await registry.list()).filter((each) => each.hosted);
    for (const record of registered) {
      const workspace = hosted.get(record.id) ?? summaryOf(record);
      hosted.set(record.id, workspace);
      const was = previous?.fingerprint.sources.get(record.id);
      const now = before?.sources.get(record.id);
      const edited =
        was === undefined ||
        now === undefined ||
        fingerprintOf("", new Map([[record.id, was]])).digest !==
          fingerprintOf("", new Map([[record.id, now]])).digest;
      if (previous === undefined || edited) {
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
    // Judged on the generation current now, not when the load began: one
    // that died meanwhile leaves nothing a partial load would replace.
    const running =
      previous !== undefined &&
      previous === current &&
      previous.exit === undefined;
    if (running && failed.length > 0) {
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
   * Keep which workspaces `generation` hosts in its record, for `status`
   * to read. Writes are made one at a time, each of the set as it is when
   * it runs, so only the latest is ever written, in order. A write that
   * fails is reported and kept to write again after the replacement
   * backoff, until one lands; a generation that retires, exits, or whose
   * daemon stops is written no more. Resolves once the write it asked for
   * has been tried.
   */
  function recordHosts(generation: Generation): Promise<void> {
    hostsDue.add(generation);
    hostsWritten = hostsWritten.then(writeHostsDue);
    return hostsWritten;
  }

  async function writeHostsDue(): Promise<void> {
    for (const generation of [...hostsDue]) {
      hostsDue.delete(generation);
      if (
        stopping ||
        generation.role === "retiring" ||
        generation.exit !== undefined
      ) {
        continue;
      }
      try {
        await records.hosting(generation.number, [...generation.hosts]);
      } catch (error) {
        print(
          `[marbles] which workspaces engine generation ${String(generation.number)} hosts was not recorded: ${message(error)}; it is written again after a backoff`
        );
        hostsDue.add(generation);
      }
    }
    if (hostsDue.size === 0) {
      // A retry armed for a write that has landed since has nothing to do.
      clock.clearTimeout(hostsTimer);
      hostsTimer = undefined;
      hostsDelay = REPLACE_MIN_MS;
      return;
    }
    if (hostsTimer === undefined && !stopping) {
      hostsTimer = clock.setTimeout(() => {
        hostsTimer = undefined;
        hostsWritten = hostsWritten.then(writeHostsDue);
      }, hostsDelay);
      hostsDelay = Math.min(hostsDelay * 2, REPLACE_MAX_MS);
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
      const own =
        failures === undefined ? why : failures.get(workspace.summary.id);
      tellRefused(workspace, previous, own, why);
    }
    await stopGeneration(candidate);
    await records.mark(candidate.number, "failed", why).catch(() => undefined);
  }

  /**
   * Tell `workspace` the candidate did not take over: one `previous` still
   * runs stays ready, saying the change did not load, in its summary and
   * to whoever follows its lines; one that was coming up has failed.
   */
  function tellRefused(
    workspace: Hosted,
    previous: Generation | undefined,
    own: string | undefined,
    why: string
  ): void {
    const { id, state } = workspace.summary;
    if (previous?.hosts.has(id)) {
      if (own === undefined) {
        setState(workspace, "ready");
        return;
      }
      const said = `a change did not load, so the previous load still runs: ${own}`;
      setState(workspace, "ready", { error: said });
      forwardLine(id, said);
    } else if (state === "starting" || state === "reloading") {
      setState(workspace, "failed", { error: own ?? why });
    }
  }

  /**
   * A switch soon, once the edits that asked for it have settled. A forced
   * one stays forced when a later ask replaces its timer, so a replacement
   * the daemon owes is never dropped for a source change that turns out
   * to be nothing new.
   */
  function scheduleSwitch(
    reason: string,
    {
      because = [reason],
      delayMs = SWITCH_DEBOUNCE_MS,
      force: asked = false,
    }: {
      /** What asked for it, said so that `idle` can name it. */
      readonly because?: readonly string[];
      readonly delayMs?: number;
      readonly force?: boolean;
    } = {}
  ): void {
    if (stopping) {
      return;
    }
    clock.clearTimeout(switchTimer);
    switchForced ||= asked;
    switchReasons.push(...because);
    switchTimer = clock.setTimeout(() => {
      switchTimer = undefined;
      switchReasons.length = 0;
      const force = switchForced;
      switchForced = false;
      // Nothing new since the current generation loaded, or since a
      // candidate refused it: no switch, unless one is needed whatever
      // the sources say.
      const wanted = async (): Promise<boolean> => {
        if (force) {
          return true;
        }
        const target = current;
        if (target !== undefined && (await unchanged(target.fingerprint))) {
          return false;
        }
        return !(refused !== undefined && (await unchanged(refused)));
      };
      switchGenerations(reason, {}, wanted).catch((error: unknown) => {
        print(`[marbles] no switch: ${message(error)}`);
      });
    }, delayMs);
  }

  /**
   * Whether what the current generation loaded changed, saying which
   * workspace did; with none current, whether anything is registered. A
   * change that is what a candidate refused last is no change.
   */
  async function pollOnce(): Promise<void> {
    const target = current;
    if (switchRunning || (target === undefined && hosted.size === 0)) {
      return;
    }
    const now =
      target === undefined
        ? undefined
        : await fingerprintNow(target.fingerprint);
    if (target !== undefined && now?.digest === target.fingerprint.digest) {
      return;
    }
    if (refused !== undefined && (await unchanged(refused))) {
      return;
    }
    // Looked at again after the reads: a switch that began meanwhile
    // decides what is current, and the next poll compares with that.
    if (switchRunning || current !== target) {
      return;
    }
    if (target !== undefined && now !== undefined) {
      sayChanged(target.fingerprint, now);
    }
    scheduleSwitch("a source or the installation changed", {
      because: whyNow(target, now),
    });
  }

  /** Why the poll asks for a switch: what differs from what `target` recorded, or that none is current. */
  function whyNow(
    target: Generation | undefined,
    now: Fingerprint | undefined
  ): string[] {
    if (target === undefined || now === undefined) {
      return [
        "no generation is current, and the registered workspaces are not what a candidate refused",
      ];
    }
    return differences(target.fingerprint, now).map(
      (line) =>
        `engine generation ${String(target.number)}'s fingerprint: ${line}`
    );
  }

  /** A line for each workspace whose part of `now` differs from `was`. */
  function sayChanged(was: Fingerprint, now: Fingerprint): void {
    for (const [id, part] of now.sources) {
      const before = was.sources.get(id);
      if (
        before !== undefined &&
        fingerprintOf("", new Map([[id, before]])).digest !==
          fingerprintOf("", new Map([[id, part]])).digest
      ) {
        print(`[${id}] source changed · reloading`);
      }
    }
  }

  /** Poll what the current generation loaded; a change asks for a switch. */
  let polling = false;
  const poll = setInterval(() => {
    if (polling || stopping || switchRunning || switchTimer !== undefined) {
      return;
    }
    polling = true;
    pollOnce()
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, SOURCE_POLL_MS);
  poll.unref();

  // What was let go and not taken over, notice or none, from the database.
  let sweeping = false;
  const sweeper = setInterval(() => {
    if (sweeping || stopping) {
      return;
    }
    sweeping = true;
    sweep(undefined)
      .catch(() => undefined)
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_MS);
  sweeper.unref();

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
    return attachInTurn(workspace, config, configPath, setup);
  }

  /**
   * The attach itself, in the daemon's turn. One that finds the workspace
   * detaching waits for that detach out of the turn, then tries again: it
   * hosts the workspace afresh once the detach is done, and is refused as
   * any attach is if the daemon began to stop meanwhile.
   */
  async function attachInTurn(
    workspace: Workspace,
    config: string | null,
    configPath: string,
    setup: SetupDraftParams | undefined
  ): Promise<WorkspaceSummary> {
    for (;;) {
      const attached = await inTurn(
        async (): Promise<
          | { readonly summary: WorkspaceSummary }
          | { readonly detaching: Promise<void> }
        > => {
          refuseWhileStopping();
          // Its runs and sessions would be written through the link.
          if (!insideState(layout.state, workspace.id)) {
            throw new Error(
              `the state of workspace ${workspace.id} at ${workspace.dir} links out of the state root; it is not hosted`
            );
          }
          const existing = hosted.get(workspace.id);
          if (existing?.detaching !== undefined) {
            return { detaching: existing.detaching };
          }
          if (existing !== undefined && existing.summary.state !== "stopped") {
            const again = await attachAgain(existing, configPath, setup);
            if (again !== undefined) {
              return { summary: again };
            }
          }
          return {
            summary: await hostNew(workspace, config, configPath, setup),
          };
        }
      );
      if ("summary" in attached) {
        return attached.summary;
      }
      // Done or failed, the detach is over: the next try decides.
      await attached.detaching.catch(() => undefined);
    }
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
    // Not registered unless it was, when it does not load: it must not
    // keep every later generation from loading cleanly.
    const unregister = async (): Promise<void> => {
      if (before?.hosted !== true) {
        await registry.unhost(workspace.id);
      }
    };
    const target = current;
    if (target === undefined) {
      try {
        await runSwitch(
          `workspace ${workspace.id} attached`,
          setup === undefined ? {} : { [workspace.id]: setup }
        );
      } catch (error) {
        await unregister();
        throw error;
      }
      if (entry.summary.state === "failed") {
        await unregister();
        throw new Error(entry.summary.error ?? "the workspace did not load");
      }
      return entry.summary;
    }
    // Its part of the fingerprint is taken before it loads, and grows as
    // the load says what it read.
    target.fingerprint = withSource(
      target.fingerprint,
      workspace.id,
      printNow(
        { config, id: workspace.id, root: workspace.root },
        [],
        digests,
        ignored
      )
    );
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
      target.fingerprint = withSource(
        target.fingerprint,
        workspace.id,
        undefined
      );
      await unregister();
      setState(entry, "failed", { error: message(error) });
      throw error;
    }
    target.hosts.add(workspace.id);
    entry.setup = undefined;
    setState(entry, "ready", { pid: target.child.pid ?? -1 });
    await recordHosts(target);
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
   * Drain workspace `id` in each of `hosting`, current first: until
   * then its runs stay reachable. A generation that exits as it drains,
   * or whose daemon stops meanwhile, has drained.
   */
  async function drainEverywhere(
    id: string,
    hosting: readonly Generation[]
  ): Promise<void> {
    for (const generation of hosting) {
      print(
        `[${id}] detaching · waiting for engine generation ${String(generation.number)} to finish its work`
      );
      try {
        await ask(generation, GENERATION_METHODS.unhost, { id });
      } catch (error) {
        const going =
          stopping ||
          generation.exit !== undefined ||
          !generation.channel?.open;
        if (!going) {
          throw error;
        }
      }
      generation.hosts.delete(id);
      await recordHosts(generation);
    }
  }

  /**
   * Stop hosting workspace `id`, in three steps. In the daemon's turn it
   * is marked detaching and recorded as not hosted, so no switch loads it
   * again. Out of the turn, every generation hosting it drains it: its
   * running work finishes, reachable meanwhile, and a switch or an attach
   * of another workspace is not held up however long that takes. Then, in
   * the turn again, its routing goes. A drain that fails leaves it hosted,
   * for the detach to be tried again. A detach that finds it gone already
   * has nothing to do; one that finds it detaching waits for that one.
   */
  async function detach(id: string): Promise<void> {
    const begun = await inTurn(async () => {
      const workspace = hosted.get(id);
      if (workspace === undefined) {
        return;
      }
      if (workspace.detaching !== undefined) {
        return { done: workspace.detaching };
      }
      // The record first: a write that fails detaches nothing, so the
      // detach can be tried again; once written, no boot hosts it again.
      await registry.unhost(id);
      if (current !== undefined) {
        // It no longer loads this one: no switch for it.
        current.fingerprint = withSource(current.fingerprint, id, undefined);
      }
      const done = finishDetach(workspace, hostsOf(id));
      workspace.detaching = done;
      return { done };
    });
    await begun?.done;
  }

  async function finishDetach(
    workspace: Hosted,
    hosting: readonly Generation[]
  ): Promise<void> {
    const { id } = workspace.summary;
    let failure: { readonly error: unknown } | undefined;
    try {
      await drainEverywhere(id, hosting);
    } catch (error) {
      failure = { error };
    }
    await inTurn(() => {
      workspace.detaching = undefined;
      if (failure === undefined) {
        hosted.delete(id);
        setState(workspace, "stopped");
      }
      return Promise.resolve();
    });
    if (failure !== undefined) {
      throw failure.error;
    }
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

  /**
   * The generation that owns run `runId` of workspace `id`: its run's
   * owner's. `undefined` when the run is not stored, or its owner is gone,
   * which the current generation answers for. A run a live process owns
   * that is not one of these generations is refused when `acting`: nothing
   * here may change it.
   */
  async function ownerOf(
    id: string,
    runId: unknown,
    acting: boolean
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
    const owner = { pid: run.owner.pid, started: run.owner.started ?? null };
    const found = hostsOf(id).find(
      (generation) =>
        generation.identity !== undefined &&
        sameProcess(generation.identity, owner)
    );
    if (acting && found === undefined && !isGone(owner)) {
      throw new Error(
        `run ${runId} is owned by pid ${String(owner.pid)}, which is not an engine generation of this Marbles process`
      );
    }
    return found;
  }

  /**
   * Ask each generation hosting workspace `id` in turn until one answers:
   * a question or an activity is held by whichever generation runs, or
   * took over, the run it belongs to, and the others refuse it, changing
   * nothing. A retired generation refuses a question it is letting go
   * (`QuestionMovingError`): then this waits for the workspace's next
   * handover or switch and asks again, until `HELD_WAIT_MS` has passed. One
   * no generation holds may be a run let go whose notice was lost: it is
   * offered to the current generation at once, and asked once more.
   * Rejects as the first refusal that is not a move did.
   */
  async function askEach(
    id: string,
    method: string,
    params: unknown
  ): Promise<unknown> {
    const deadline = Date.now() + HELD_WAIT_MS;
    let swept = false;
    for (;;) {
      const asked = await askAll(id, method, params);
      if ("value" in asked) {
        return asked.value;
      }
      const moving = asked.errors.some(isMoving);
      const left = deadline - Date.now();
      if (left <= 0 || !(moving || !swept)) {
        throw asked.errors.find((error) => !isMoving(error)) ?? asked.errors[0];
      }
      if (moving) {
        await nextChange(id, Math.min(left, HANDOVER_RETRY_MS * 10));
      } else {
        swept = true;
        await sweep([id], { now: true });
      }
    }
  }

  /** One pass of `askEach`: the first answer, or every refusal. */
  async function askAll(
    id: string,
    method: string,
    params: unknown
  ): Promise<{ readonly value: unknown } | { readonly errors: unknown[] }> {
    const hosts = hostsOf(id);
    if (hosts.length === 0) {
      throw new Error(`no engine generation hosts workspace ${id} now`);
    }
    const errors: unknown[] = [];
    for (const generation of hosts) {
      try {
        return { value: await ask(generation, method, params) };
      } catch (error) {
        errors.push(error);
      }
    }
    return { errors };
  }

  /**
   * Ask the generation owning run `runId` of workspace `id`, read again
   * for each try: a run on its way to another generation is refused by the
   * one letting it go (`QuestionMovingError`), and asked of its next owner
   * once the workspace's next handover or switch lands. `NO_OWNER_HERE`
   * when no generation of this daemon owns it.
   */
  async function askOwner(
    id: string,
    name: string,
    method: string,
    runId: unknown,
    params: unknown
  ): Promise<{ readonly value: unknown } | typeof NO_OWNER_HERE> {
    const deadline = Date.now() + HELD_WAIT_MS;
    for (;;) {
      const owner = await ownerOf(id, runId, name !== WORKSPACE_METHODS.getRun);
      if (owner === undefined) {
        return NO_OWNER_HERE;
      }
      try {
        return { value: await ask(owner, method, params) };
      } catch (error) {
        const left = deadline - Date.now();
        if (!isMoving(error) || left <= 0) {
          throw error;
        }
        await nextChange(id, Math.min(left, HANDOVER_RETRY_MS * 10));
      }
    }
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
    // Its runs stay reachable while it drains; nothing new begins.
    if (workspace.detaching !== undefined && DISPATCHING.has(name)) {
      throw new Error(`workspace ${id} is detaching; it starts no new work`);
    }
    if (RUN_METHODS.has(name)) {
      const answered = await askOwner(id, name, method, rest.runId, params);
      if (answered !== NO_OWNER_HERE) {
        return answered.value;
      }
    }
    if (HELD_METHODS.has(name)) {
      // A run on its way here is taken over before anyone asks for it.
      await handovers.get(id);
      return await askEach(id, method, params);
    }
    return await askCurrent(workspace, method, params);
  }

  /**
   * The current generation, once it has started, when it hosts `workspace`
   * and the workspace is up; else why not, thrown.
   */
  async function startedCurrent(workspace: Hosted): Promise<Generation> {
    const target = current;
    // A generation current but still starting answers once it has started.
    await settledStart(target);
    const { error, id, state } = workspace.summary;
    if (workspace.detaching !== undefined) {
      throw new Error(`workspace ${id} is detaching`);
    }
    if (
      target === undefined ||
      target !== current ||
      !target.hosts.has(id) ||
      state === "failed" ||
      state === "starting" ||
      state === "stopped"
    ) {
      throw new Error(
        `workspace ${id} is ${state}${error ? `: ${error}` : ""}`
      );
    }
    return target;
  }

  /**
   * Ask the current generation, once it has started, about workspace
   * `workspace`. A launch that reached a generation as it began to retire
   * is refused there, recording nothing, and asked of the one current now.
   */
  async function askCurrent(
    workspace: Hosted,
    method: string,
    params: unknown
  ): Promise<unknown> {
    const { id } = workspace.summary;
    const deadline = Date.now() + HELD_WAIT_MS;
    for (;;) {
      const target = await startedCurrent(workspace);
      try {
        return await ask(target, method, params);
      } catch (error) {
        const left = deadline - Date.now();
        if (!isMoving(error) || left <= 0) {
          throw error;
        }
        if (current === target) {
          await nextChange(id, Math.min(left, HANDOVER_RETRY_MS * 10));
        }
      }
    }
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
    // What an earlier Marbles process left recorded live is not this
    // one's: a generation it left drains and exits once its connection to
    // that process is gone, and what it held is a gone process's then.
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
      clearInterval(sweeper);
      clock.clearTimeout(switchTimer);
      clock.clearTimeout(hostsTimer);
      hostsTimer = undefined;
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
    async idle() {
      // A turn may queue another while it runs: wait until none is left.
      for (;;) {
        const waited = turn;
        const written = hostsWritten;
        await waited;
        await written;
        if (turn === waited && hostsWritten === written) {
          const hostsReasons = [...hostsDue].map(
            (generation) =>
              `which workspaces engine generation ${String(generation.number)} hosts is to be written again`
          );
          return {
            reasons: [
              ...(switchTimer === undefined ? [] : switchReasons),
              ...(hostsTimer === undefined ? [] : hostsReasons),
            ],
            scheduled: switchTimer !== undefined || hostsTimer !== undefined,
          };
        }
      }
    },
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
