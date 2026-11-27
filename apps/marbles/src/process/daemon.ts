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
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { holdsLock } from "@foundry/lib/node/file-lock";
import {
  compareStarts,
  isGone,
  lookProcesses,
  type ProcessIdentity,
  sameProcess,
  nodeStartedAt as startOf,
} from "@foundry/lib/node/process-identity";
import {
  queuedRuns,
  queuedRunsOwnedBy,
  readExecution,
} from "~/database/executions";
import { GenerationRecords } from "~/database/generations";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { WorkspaceRegistry } from "~/database/workspaces";
import type { Layout } from "~/layout";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";
import {
  insideState,
  type Workspace,
  type WorkspaceRecord,
} from "~/lib/state/workspace";
import type { WorkspaceSummary } from "~/model/connection";
import type { LiveRun } from "~/model/dashboard";
import { Channel, socketTransport } from "~/process/channel";
import {
  differences,
  FileDigests,
  type Fingerprint,
  fingerprintOf,
  installationDigest,
  printNow,
  type WorkspacePrint,
  watching,
  withRead,
} from "~/process/fingerprint";
import type { ProcessInstance } from "~/process/instance";
import { claimProcess, STATE_MODE } from "~/process/instance";
import {
  attachParamsSchema,
  CLIENT_NOTIFICATIONS,
  DAEMON_METHODS,
  GENERATION_METHODS,
  GENERATION_NOTIFICATIONS,
  GENERATION_STOP_TIMEOUT_MS,
  type HelloResult,
  handedParamsSchema,
  hostResultSchema,
  isWorkspaceMethod,
  type LoadResult,
  lineParamsSchema,
  liveRunsSchema,
  loadResultSchema,
  MAX_LINE_BYTES,
  PROTOCOL,
  queuedTakeSchema,
  readParamsSchema,
  registerParamsSchema,
  type SetupDraftParams,
  startResultSchema,
  WORKSPACE_METHODS,
  WORKSPACE_PREFIX,
  type WorkspaceLoadResult,
  workspaceIdSchema,
} from "~/process/protocol";
import { RUNTIME_FLAGS, runtime } from "~/process/runtime";
import { recordSpawned } from "~/process/spawned";
import {
  DEFAULT_SOURCE,
  resolveSource,
  sourceFiles,
  sourceRoot,
} from "~/workspace/source";
import { version } from "../../package.json";

export interface DaemonClock {
  clearTimeout(handle: unknown): void;
  setTimeout(work: () => void, ms: number): unknown;
}

export interface DaemonOptions {
  readonly clock?: DaemonClock;
  readonly generationEntry?: string;
  readonly layout: Layout;
  readonly print?: (line: string) => void;
}

export interface Daemon {
  close(): Promise<void>;
  readonly closed: Promise<void>;
  idle(): Promise<{
    readonly reasons: readonly string[];
    readonly scheduled: boolean;
  }>;
  readonly pid: number;
  pollNow(): Promise<boolean>;
  readonly socket: string;
  sweepNow(): Promise<void>;
}

const STOP_TIMEOUT_MS = GENERATION_STOP_TIMEOUT_MS;
const READY_TIMEOUT_MS = 120_000;
const SWITCH_DEBOUNCE_MS = 500;
const SOURCE_POLL_MS = 1000;
const INSTALLATION_POLL_MS = 5000;
const REPLACE_MIN_MS = 1000;
const REPLACE_MAX_MS = 30_000;
const STABLE_MS = 30_000;
const HANDOVER_ATTEMPTS = 5;
const HANDOVER_RETRY_MS = 200;
const SWEEP_MS = 2000;
const REOFFER_MS = 30_000;
const HELD_WAIT_MS = 30_000;
const LIVE_WORK_WAIT_MS = 2000;
const STDERR_TAIL = 20;
const CLAIM_CHECK_MS = 5000;

function generationEntry(): string {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./generation.ts" : "./generation.js",
      import.meta.url
    )
  );
}

interface Generation {
  channel?: Channel;
  readonly child: ChildProcess;
  exit?: { readonly clean: boolean; readonly why: string };
  readonly exited: Promise<void>;
  fingerprint: Fingerprint;
  readonly hosts: Set<string>;
  identity?: ProcessIdentity;
  readonly number: number;
  readonly registered: PromiseWithResolvers<Channel>;
  role: "candidate" | "current" | "retiring";
  since?: number;
  readonly spawnedAs: ProcessIdentity | undefined;
  readonly started: PromiseWithResolvers<void>;
  readonly tail: string[];
  readonly token: string;
}

interface Hosted {
  detaching?: Promise<void>;
  setup?: SetupDraftParams;
  readonly source: string;
  summary: WorkspaceSummary;
}

interface Client {
  readonly channel: Channel;
  readonly subscriptions: Set<string>;
}

const RUN_METHODS = new Set<string>([
  WORKSPACE_METHODS.cancel,
  WORKSPACE_METHODS.cancelRun,
  WORKSPACE_METHODS.getRun,
  WORKSPACE_METHODS.pause,
  WORKSPACE_METHODS.resume,
  WORKSPACE_METHODS.send,
  WORKSPACE_METHODS.steer,
]);

const HELD_METHODS = new Set<string>([
  WORKSPACE_METHODS.answer,
  WORKSPACE_METHODS.stopActivity,
]);

const GATHERING_METHODS = new Set<string>([WORKSPACE_METHODS.snapshot]);

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

const TRUNCATED = `[line truncated at ${String(MAX_LINE_BYTES)} bytes]`;

export function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let size = 0;
  let cut = false;
  const take = (piece: string): void => {
    if (cut || piece === "") {
      return;
    }
    const bytes = Buffer.byteLength(piece);
    if (size + bytes <= MAX_LINE_BYTES) {
      buffer += piece;
      size += bytes;
      return;
    }
    const head = new StringDecoder("utf8").write(
      Buffer.from(piece).subarray(0, MAX_LINE_BYTES - size)
    );
    onLine(`${buffer}${head} ${TRUNCATED}`);
    buffer = "";
    size = 0;
    cut = true;
  };
  return (chunk) => {
    const text = decoder.write(chunk);
    let start = 0;
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      take(text.slice(start, newline));
      if (!cut) {
        onLine(buffer);
      }
      buffer = "";
      size = 0;
      cut = false;
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    take(text.slice(start));
  };
}

const NO_OWNER_HERE: unique symbol = Symbol("no generation here owns the run");

function isMoving(error: unknown): boolean {
  return error instanceof Error && MOVING_ERRORS.has(error.name);
}

const MOVING_ERRORS = new Set(["EngineRetiringError"]);

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
  mkdirSync(dirname(layout.state), { recursive: true });
  mkdirSync(layout.state, { mode: STATE_MODE, recursive: true });
  chmodSync(layout.state, STATE_MODE);
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
    try {
      claim.release();
    } catch {
      // biome-ignore lint/style/useErrorCause: Preserve the original database initialization error.
      throw error;
    }
    throw error;
  }
  const registry = new WorkspaceRegistry({
    acceptWorkspace: (workspaceId) => insideState(layout.state, workspaceId),
    database: database.database,
  });
  const records = new GenerationRecords({
    database: database.database,
    liveness: NODE_OWNER_LIVENESS,
  });
  let hostsWritten: Promise<void> = Promise.resolve();
  const hostsDue = new Set<Generation>();
  const currentDue = new Set<Generation>();
  let hostsTimer: unknown;
  let hostsDelay = REPLACE_MIN_MS;
  const hosted = new Map<string, Hosted>();
  const generations = new Set<Generation>();
  let current: Generation | undefined;
  const clients = new Set<Client>();
  const sockets = new Set<Socket>();
  const { startedAt } = claim;
  let closing: Promise<void> | undefined;
  let stopping = false;
  let refused: Fingerprint | undefined;
  const digests = new FileDigests();
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
  let switchForced = false;
  const switchReasons: string[] = [];
  let switchRunning = false;
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

  function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let handle: unknown;
    const limit = new Promise<never>((_, reject) => {
      handle = clock.setTimeout(
        () => reject(new Error(`${what} timed out`)),
        ms
      );
    });
    return Promise.race([work, limit]).finally(() =>
      clock.clearTimeout(handle)
    );
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
        detached: true,
        env: {
          ...process.env,
          FOUNDRY_ROOT: layout.home,
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
    recordSpawned(child.pid, true, { recovery: false });
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
    if (generation === current && generation.role !== "retiring") {
      onCurrentExit(generation, exit.why);
    } else if (generation.role === "retiring" && !exit.clean) {
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

  function register(token: string, channel: Channel): Generation {
    const generation = [...generations].find(
      (candidate) => candidate.token === token
    );
    if (generation === undefined) {
      throw new Error("no engine generation was spawned with this token");
    }
    if (generation.channel !== undefined) {
      throw new Error(
        `engine generation ${String(generation.number)} has registered already`
      );
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
    if (method === GENERATION_NOTIFICATIONS.handed) {
      const parsed = handedParamsSchema.safeParse(params);
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

  const handovers = new Map<string, Promise<void>>();
  const offering = new Map<string, Promise<void>>();
  const declined = new Map<string, number>();
  const orphansDeclined = new Map<string, number>();
  const orphansReported = new Set<string>();
  const holding: { of: number; readonly keys: Set<string> } = {
    keys: new Set(),
    of: 0,
  };
  const waiting = new Map<string, Set<() => void>>();
  const takingHanded = new Map<string, Promise<unknown>>();
  const taking = new Map<string, Promise<unknown>>();

  function outstanding(
    table: Map<string, Promise<unknown>>,
    key: string,
    asked: Promise<unknown>,
    settled: (value: unknown) => void
  ): Promise<unknown> {
    table.set(key, asked);
    const clear = (): void => {
      if (table.get(key) === asked) {
        table.delete(key);
      }
    };
    asked.then((value) => {
      clear();
      settled(value);
    }, clear);
    return asked;
  }

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

  function nextChange(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wakers = waiting.get(id) ?? new Set();
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        wakers.delete(wake);
        if (wakers.size === 0 && waiting.get(id) === wakers) {
          waiting.delete(id);
        }
        resolve();
      }, ms);
      wakers.add(wake);
      waiting.set(id, wakers);
    });
  }

  function handOver(id: string, runId: string): Promise<void> {
    const key = `${id}\0${runId}`;
    const pending = offering.get(key);
    if (pending !== undefined) {
      return pending;
    }
    if (takingHanded.has(key)) {
      return Promise.resolve();
    }
    const previous = handovers.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      for (let attempt = 0; attempt < HANDOVER_ATTEMPTS; attempt += 1) {
        const target = current;
        await settledStart(target);
        if (
          target === undefined ||
          target !== current ||
          !target.hosts.has(id)
        ) {
          return;
        }
        if (takingHanded.has(key)) {
          return;
        }
        try {
          const asked = outstanding(
            takingHanded,
            key,
            ask(target, GENERATION_METHODS.takeHanded, { id, runId }),
            (taken) => {
              if (taken === true) {
                declined.delete(key);
                held(target, key);
                changed(id);
              }
            }
          );
          if (
            (await within(
              asked,
              HELD_WAIT_MS,
              `taking handed run ${runId}`
            )) === true
          ) {
            declined.delete(key);
            held(target, key);
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

  function held(target: Generation, key: string): void {
    if (holding.of === target.number) {
      holding.keys.add(key);
    }
  }

  async function sweep(
    ids: Iterable<string> | undefined,
    { now = false }: { readonly now?: boolean } = {}
  ): Promise<void> {
    const target = current;
    if (target === undefined || stopping) {
      return;
    }
    if (holding.of !== target.number) {
      holding.of = target.number;
      holding.keys.clear();
    }
    const offers: Promise<void>[] = [];
    for (const id of ids ?? target.hosts) {
      offers.push(takeOrphans(target, id));
      for (const runId of await handedUntaken(target, id)) {
        const at = declined.get(`${id}\0${runId}`);
        if (now || at === undefined || Date.now() - at >= REOFFER_MS) {
          offers.push(handOver(id, runId));
        }
      }
    }
    await Promise.all(offers);
  }

  async function handedUntaken(
    target: Generation,
    id: string
  ): Promise<readonly string[]> {
    try {
      const owner = target.identity;
      const queued =
        owner === undefined
          ? []
          : await queuedRunsOwnedBy(database.database, id, owner);
      return queued.filter((runId) => !holding.keys.has(`${id}\0${runId}`));
    } catch {
      return [];
    }
  }

  async function takeOrphans(target: Generation, id: string): Promise<void> {
    let queued: Awaited<ReturnType<typeof queuedRuns>>;
    try {
      queued = await queuedRuns(database.database, id);
    } catch {
      return;
    }
    const judged = new Map<string, boolean>();
    for (const { id: runId, owner } of queued) {
      if (
        target.identity !== undefined &&
        sameProcess(owner, target.identity)
      ) {
        continue;
      }
      const key = `${String(owner.pid)}\0${owner.started ?? ""}`;
      const gone = judged.get(key) ?? isGone(owner);
      judged.set(key, gone);
      if (!gone || current !== target) {
        continue;
      }
      await offerOrphan(target, id, runId, owner);
    }
  }

  async function offerOrphan(
    target: Generation,
    id: string,
    runId: string,
    owner: ProcessIdentity
  ): Promise<void> {
    const key = `${id}\0${runId}`;
    const at = orphansDeclined.get(key);
    if (taking.has(key) || (at !== undefined && Date.now() - at < REOFFER_MS)) {
      return;
    }
    let why: string;
    try {
      const asked = outstanding(
        taking,
        key,
        ask(target, GENERATION_METHODS.takeQueued, { id, owner, runId }),
        (value) => {
          if (queuedTakeSchema.safeParse(value).data?.taken === true) {
            orphansDeclined.delete(key);
            orphansReported.delete(key);
          }
        }
      );
      const take = queuedTakeSchema.parse(
        await within(asked, HELD_WAIT_MS, `taking queued run ${runId}`)
      );
      if (take.taken) {
        orphansDeclined.delete(key);
        orphansReported.delete(key);
        return;
      }
      ({ why } = take);
    } catch (error) {
      why = message(error);
    }
    orphansDeclined.set(key, Date.now());
    if (!orphansReported.has(key)) {
      orphansReported.add(key);
      print(
        `[${id}] queued run ${runId} of gone process pid ${String(owner.pid)} left queued: ${why}; offered again every ${String(REOFFER_MS / 1000)} s`
      );
    }
  }

  async function stopGeneration(generation: Generation): Promise<void> {
    const { exited } = generation;
    if (generation.exit !== undefined) {
      return;
    }
    try {
      if (generation.channel?.open) {
        await timeout(
          Promise.race([
            generation.channel.request(GENERATION_METHODS.stop),
            exited,
          ]),
          STOP_TIMEOUT_MS,
          `stopping engine generation ${String(generation.number)}`
        );
      } else if (!signalProven(generation, "SIGTERM")) {
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
        if (signalProven(generation, "SIGKILL")) {
          await exited;
        }
      }
    }
  }

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

  async function unchanged(fingerprint: Fingerprint): Promise<boolean> {
    return (await fingerprintNow(fingerprint)).digest === fingerprint.digest;
  }

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

  function loadedId(load: WorkspaceLoadResult): string | undefined {
    return (
      load.id ??
      [...hosted.values()].find(
        (workspace) =>
          resolvePath(workspace.summary.root) === resolvePath(load.root)
      )?.summary.id
    );
  }

  function switchGenerations(
    reason: string,
    setups: Readonly<Record<string, SetupDraftParams>> = {},
    wanted: () => Promise<boolean> = () => Promise.resolve(true)
  ): Promise<void> {
    return inTurn(async () => {
      refuseWhileStopping();
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
    const { fingerprint, watched } = await announceSwitch(previous);
    const number = await records.begin(fingerprint.digest);
    refuseWhileStopping();
    const candidate = spawnGeneration(number, fingerprint);
    print(`[marbles] engine generation ${String(number)} starting: ${reason}`);
    if (candidate.spawnedAs !== undefined) {
      await records.spawned(
        number,
        candidate.spawnedAs.pid,
        candidate.spawnedAs.started
      );
    }
    let loaded: LoadResult;
    try {
      loaded = await loadCandidate(candidate, previous);
    } catch (error) {
      refused = watching(candidate.fingerprint, watched);
      await refuse(candidate, previous, error);
      throw error;
    }
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
      const replacing = current === candidate;
      if (replacing) {
        current = undefined;
      }
      await refuse(candidate, undefined, error, { hostLost: true });
      if (replacing) {
        replaceCurrent("the engine generation did not start");
      }
      throw error;
    }
    candidate.since = Date.now();
    await markCurrent(candidate);
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
    await recordHosts(candidate);
  }

  async function markCurrent(generation: Generation): Promise<void> {
    try {
      await records.mark(generation.number, "current");
    } catch (error) {
      print(
        `[marbles] engine generation ${String(generation.number)} was not recorded current: ${message(error)}; it is written again with the workspaces it hosts`
      );
      currentDue.add(generation);
    }
  }

  async function announceSwitch(previous: Generation | undefined): Promise<{
    readonly fingerprint: Fingerprint;
    readonly watched: Fingerprint | undefined;
  }> {
    installation = installationDigest(script, version);
    installationAt = Date.now();
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
    return { fingerprint, watched: before };
  }

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
    await records.identify(
      candidate.number,
      loaded.identity.started ?? candidate.spawnedAs?.started ?? null
    );
    const failed = loaded.loads.filter((load) => load.error !== undefined);
    const running =
      previous !== undefined &&
      previous === current &&
      previous.exit === undefined;
    if (running && failed.length > 0) {
      throw new CandidateError(failed);
    }
    return loaded;
  }

  async function retire(
    previous: Generation,
    successor: ProcessIdentity
  ): Promise<void> {
    previous.role = "retiring";
    await records.mark(previous.number, "retiring").catch((error: unknown) => {
      print(
        `[marbles] engine generation ${String(previous.number)} was not recorded retiring: ${message(error)}`
      );
    });
    try {
      await timeout(
        ask(previous, GENERATION_METHODS.retire, { successor }),
        STOP_TIMEOUT_MS,
        `retiring engine generation ${String(previous.number)}`
      );
    } catch (error) {
      print(`[marbles] ${message(error)}; stopping it`);
      await stopGeneration(previous);
    }
  }

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
        currentDue.delete(generation);
        continue;
      }
      try {
        if (currentDue.has(generation)) {
          await records.mark(generation.number, "current");
          currentDue.delete(generation);
        }
        await records.hosting(generation.number, [...generation.hosts]);
      } catch (error) {
        print(
          `[marbles] which workspaces engine generation ${String(generation.number)} hosts was not recorded: ${message(error)}; it is written again after a backoff`
        );
        hostsDue.add(generation);
      }
    }
    if (hostsDue.size === 0) {
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

  async function refuse(
    candidate: Generation,
    previous: Generation | undefined,
    error: unknown,
    { hostLost = false }: { readonly hostLost?: boolean } = {}
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
      tellRefused(workspace, previous, own, why, hostLost);
    }
    await stopGeneration(candidate);
    await records.mark(candidate.number, "failed", why).catch(() => undefined);
  }

  function tellRefused(
    workspace: Hosted,
    previous: Generation | undefined,
    own: string | undefined,
    why: string,
    hostLost: boolean
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
    } else if (
      hostLost
        ? state !== "stopped"
        : state === "starting" || state === "reloading"
    ) {
      setState(workspace, "failed", { error: own ?? why });
    }
  }

  function scheduleSwitch(
    reason: string,
    {
      because = [reason],
      delayMs = SWITCH_DEBOUNCE_MS,
      force: asked = false,
    }: {
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

  let polling: Promise<boolean> | undefined;
  function pollTick(): Promise<boolean> {
    if (polling !== undefined) {
      return polling;
    }
    if (stopping || switchRunning || switchTimer !== undefined) {
      return Promise.resolve(false);
    }
    const done = pollOnce()
      .catch(() => undefined)
      .then(() => true)
      .finally(() => {
        polling = undefined;
      });
    polling = done;
    return done;
  }
  const poll = setInterval(() => {
    pollTick().catch(() => undefined);
  }, SOURCE_POLL_MS);
  poll.unref();

  let sweeping: Promise<void> | undefined;
  function sweepTick(): Promise<void> {
    if (sweeping !== undefined) {
      return sweeping;
    }
    if (stopping) {
      return Promise.resolve();
    }
    const done = Promise.all([endGoneGenerations(), sweep(undefined)])
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        sweeping = undefined;
      });
    sweeping = done;
    return done;
  }
  const sweeper = setInterval(() => {
    sweepTick().catch(() => undefined);
  }, SWEEP_MS);
  sweeper.unref();

  async function endGoneGenerations(): Promise<void> {
    for (const number of await records.endGone()) {
      print(
        `[marbles] engine generation ${String(number)} is gone, and recorded exited`
      );
    }
  }

  function attach(
    source: string,
    setup?: SetupDraftParams,
    root?: string
  ): Promise<WorkspaceSummary> {
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
            await ensureRegistered(workspace, config);
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
      await attached.detaching.catch(() => undefined);
    }
  }

  async function ensureRegistered(
    workspace: Workspace,
    config: string | null
  ): Promise<void> {
    if ((await registry.read(workspace.id))?.hosted !== true) {
      await registry.touch(workspace, config, { hosted: true });
    }
  }

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
    await runSwitch(
      `workspace ${id} attached again`,
      setup === undefined ? {} : { [id]: setup }
    );
    return existing.summary;
  }

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
    const unregister = async (): Promise<void> => {
      if (before?.hosted === true) {
        return;
      }
      if (hosted.get(workspace.id) === entry) {
        hosted.delete(workspace.id);
      }
      await registry.unhost(workspace.id);
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
      setState(entry, "failed", { error: message(error) });
      await unregister();
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

  async function detach(id: string): Promise<void> {
    const begun = await inTurn(async () => {
      const workspace = hosted.get(id);
      if (workspace === undefined) {
        return;
      }
      if (workspace.detaching !== undefined) {
        return { done: workspace.detaching };
      }
      await registry.unhost(id);
      const loadedBy = current;
      const part = loadedBy?.fingerprint.sources.get(id);
      if (loadedBy !== undefined) {
        loadedBy.fingerprint = withSource(loadedBy.fingerprint, id, undefined);
      }
      const hosting = hostsOf(id);
      const done = finishDetach(workspace, hosting, () => {
        if (loadedBy !== undefined && part !== undefined) {
          loadedBy.fingerprint = withSource(loadedBy.fingerprint, id, part);
        }
      });
      workspace.detaching = done;
      setState(workspace, "stopped", {
        error: `detaching: waiting for engine generation${hosting.length === 1 ? "" : "s"} ${hosting.map((each) => String(each.number)).join(", ")} to finish its work`,
      });
      return { done };
    });
    await begun?.done;
  }

  async function finishDetach(
    workspace: Hosted,
    hosting: readonly Generation[],
    putBack: () => void
  ): Promise<void> {
    const { id } = workspace.summary;
    let failure: { readonly error: unknown } | undefined;
    try {
      await drainEverywhere(id, hosting);
    } catch (error) {
      failure = { error };
    }
    await inTurn(async () => {
      workspace.detaching = undefined;
      if (failure === undefined) {
        hosted.delete(id);
        setState(workspace, "stopped");
        return;
      }
      putBack();
      const why = `detach failed: ${message(failure.error)}`;
      try {
        await registry.touch(
          layout.workspace(workspace.summary.root),
          workspace.summary.config,
          { hosted: true }
        );
        setState(workspace, "failed", {
          error: `${why}; attach it again to load it afresh`,
        });
      } catch (error) {
        setState(workspace, "failed", {
          error: `${why}; its registration was not put back (${message(error)}); attach it again to repair it`,
        });
      }
    });
    if (failure !== undefined) {
      throw failure.error;
    }
  }

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
    if (run?.owner === undefined) {
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

  const liveUnread = new Set<string>();

  async function liveOf(
    id: string,
    generation: Generation
  ): Promise<readonly LiveRun[]> {
    const key = `${id}:${String(generation.number)}`;
    try {
      const runs = liveRunsSchema.parse(
        await timeout(
          ask(generation, GENERATION_METHODS.liveWork, { id }),
          LIVE_WORK_WAIT_MS,
          `reading the live work of generation ${String(generation.number)}`
        )
      );
      liveUnread.delete(key);
      return runs;
    } catch (error) {
      if (!liveUnread.has(key)) {
        liveUnread.add(key);
        print(
          `[${id}] the runs of engine generation ${String(generation.number)} are left out of the dashboard: ${message(error)}`
        );
      }
      return [];
    }
  }

  async function liveElsewhere(
    id: string,
    target: Generation
  ): Promise<readonly LiveRun[]> {
    const parts = await Promise.all(
      hostsOf(id)
        .filter((generation) => generation !== target)
        .map((generation) => liveOf(id, generation))
    );
    return parts.flat();
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
      await handovers.get(id);
      return await askEach(id, method, params);
    }
    if (GATHERING_METHODS.has(name)) {
      return await askCurrent(workspace, method, params, async (target) => ({
        ...params,
        live: await liveElsewhere(id, target),
      }));
    }
    return await askCurrent(workspace, method, params);
  }

  async function startedCurrent(workspace: Hosted): Promise<Generation> {
    const target = current;
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

  async function prepareCurrent(
    workspace: Hosted,
    params: unknown,
    prepare: ((target: Generation) => Promise<unknown>) | undefined,
    deadline: number
  ): Promise<{ target: Generation; prepared: unknown }> {
    for (;;) {
      const target = await startedCurrent(workspace);
      const prepared = prepare === undefined ? params : await prepare(target);
      if (current === target) {
        return { prepared, target };
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `workspace ${workspace.summary.id} kept switching while reading its live work`
        );
      }
    }
  }

  async function askCurrent(
    workspace: Hosted,
    method: string,
    params: unknown,
    prepare?: (target: Generation) => Promise<unknown>
  ): Promise<unknown> {
    const { id } = workspace.summary;
    const deadline = Date.now() + HELD_WAIT_MS;
    for (;;) {
      const { target, prepared } = await prepareCurrent(
        workspace,
        params,
        prepare,
        deadline
      );
      if (current !== target) {
        continue;
      }
      try {
        return await ask(target, method, prepared);
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

  const claimCheck = setInterval(() => {
    if (!holdsLock(join(layout.state, "locks", "process"))) {
      print("[marbles] the claim at the state root is gone; stopping");
      close({ claimLost: true }).catch(() => undefined);
    }
  }, CLAIM_CHECK_MS);
  claimCheck.unref();

  try {
    if (existsSync(layout.socket)) {
      rmSync(layout.socket, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(layout.socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(layout.socket, 0o600);
    print(`[marbles] pid ${String(process.pid)} · ${layout.socket}`);
    await records.endAll();
    const registered = (await registry.list()).filter((each) => each.hosted);
    if (registered.length > 0) {
      for (const record of registered) {
        hosted.set(record.id, summaryOf(record));
      }
      switchGenerations("the Marbles process started").catch(
        (error: unknown) => {
          print(`[marbles] not hosted again: ${message(error)}`);
        }
      );
    }
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  function close({ claimLost = false } = {}): Promise<void> {
    closing ??= (async () => {
      stopping = true;
      clearInterval(claimCheck);
      clearInterval(poll);
      clearInterval(sweeper);
      clock.clearTimeout(switchTimer);
      clock.clearTimeout(hostsTimer);
      hostsTimer = undefined;
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
      await attempt(() => everyOf([...sockets], (socket) => socket.destroy()));
      if (claimLost) {
        await attempt(() => server.unref());
      } else {
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
    pollNow: () => pollTick(),
    socket: layout.socket,
    sweepNow: () => sweepTick(),
  };
}

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
