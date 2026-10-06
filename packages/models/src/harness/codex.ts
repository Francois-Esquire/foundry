import type { HarnessTurnDriver, StreamPart } from "@foundry/agents/harness";
import { AppServerConnection, type CliProcess } from "./app-server";
import {
  authenticate,
  codexSandbox,
  refreshSubscription,
} from "./codex-authorization";
import { createCodexEvents } from "./codex-events";
import { answerRequest, dynamicTools } from "./codex-tools";
import { type DriverRun, eventStream, inputText, record } from "./shared";

export interface CodexDriverOptions {
  agentId: string;
  apiKey?: string;
  binPath: string;
  chatgptAuthTokens?: CodexSubscriptionTokens;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  instructions?: string;
  modelId: string;
  refreshChatgptAuthTokens?: (request: {
    reason: string;
    previousAccountId?: string;
    signal: AbortSignal;
  }) => Promise<CodexSubscriptionTokens>;
  sandboxPolicy?: "workspace-write" | "read-only";
  /** Host-provided guest launcher. No native host spawn fallback exists. */
  spawn: (
    argv: readonly string[],
    options: {
      cwd: string;
      env: Readonly<Record<string, string>>;
      signal: AbortSignal;
    }
  ) => Promise<CliProcess>;
}

export interface CodexSubscriptionTokens {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string;
}

/** One live app-server per session: parent response completion never kills child threads. */
export function createCodexDriver(
  options: CodexDriverOptions
): HarnessTurnDriver {
  let connection: AppServerConnection | undefined;
  let events: ReturnType<typeof createCodexEvents> | undefined;
  let processAbort: AbortController | undefined;
  let currentRun: DriverRun | undefined;
  let queue: ReturnType<typeof eventStream<StreamPart>> | undefined;
  let parentThreadId: string | undefined;
  let turnId: string | undefined;
  let running = false;
  let removeTurnAbort: (() => void) | undefined;
  const childTurns = new Map<
    string,
    { turnId: string; abort: AbortController }
  >();
  const subscribedChildren = new Set<string>();
  /** What every thread and turn request states the same way. */
  const turnDefaults = {
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    cwd: options.cwd,
    model: options.modelId,
  } as const;
  const finishTurn = () => {
    running = false;
    turnId = undefined;
    removeTurnAbort?.();
    removeTurnAbort = undefined;
    queue?.close();
  };
  const updateTurn = (params: Record<string, unknown>) => {
    const turn = record(params.turn);
    if (running && typeof turn.id === "string") {
      turnId = turn.id;
    }
  };
  const receive = async (
    method: string,
    params: Record<string, unknown>,
    id?: string | number
  ) => {
    const liveConnection = connection;
    const liveEvents = events;
    const run = currentRun;
    if (!(liveConnection && liveEvents && run && processAbort)) {
      return;
    }
    if (id === undefined) {
      await liveEvents.receive(method, params);
      return;
    }
    if (method === "account/chatgptAuthTokens/refresh") {
      await refreshSubscription(
        liveConnection,
        params,
        id,
        options,
        processAbort.signal
      );
      return;
    }
    const activityId = liveEvents.activityId(params.threadId);
    const childTurn =
      typeof params.threadId === "string"
        ? childTurns.get(params.threadId)
        : undefined;
    const signal = running
      ? AbortSignal.any([run.signal, processAbort.signal])
      : processAbort.signal;
    try {
      await answerRequest(
        liveConnection,
        method,
        params,
        id,
        {
          ...run,
          permission: (request) => run.permission({ ...request, activityId }),
          question: (request) => run.question({ ...request, activityId }),
          // Child requests can arrive after the parent response closes.
          signal: childTurn
            ? AbortSignal.any([signal, childTurn.abort.signal])
            : signal,
        },
        (report) => liveEvents.report({ ...report, activityId }),
        activityId
      );
    } catch (error) {
      if (!childTurn?.abort.signal.aborted) {
        throw error;
      }
      liveConnection.respondError(id, "Codex subagent turn interrupted.");
    }
  };
  const startProcess = async (run: DriverRun) => {
    processAbort = new AbortController();
    const initializingAbort = processAbort;
    const abortInitialization = () =>
      initializingAbort.abort(run.signal.reason);
    run.signal.addEventListener("abort", abortInitialization, { once: true });
    removeTurnAbort = () =>
      run.signal.removeEventListener("abort", abortInitialization);
    if (run.signal.aborted) {
      abortInitialization();
    }
    const child = await options.spawn([options.binPath, "app-server"], {
      cwd: options.cwd,
      env: options.env ?? {},
      signal: processAbort.signal,
    });
    events = createCodexEvents({
      agentId: options.agentId,
      isParentThread: (threadId) =>
        threadId === undefined || threadId === parentThreadId,
      onChildTurn: (threadId, turn) => {
        if (typeof turn.id === "string" && turn.status === "inProgress") {
          if (childTurns.get(threadId)?.turnId !== turn.id) {
            childTurns.get(threadId)?.abort.abort();
            childTurns.set(threadId, {
              abort: new AbortController(),
              turnId: turn.id,
            });
          }
        } else {
          childTurns.get(threadId)?.abort.abort();
          childTurns.delete(threadId);
        }
      },
      onComplete: finishTurn,
      onTurn: updateTurn,
      push: (part) => {
        if (running) {
          queue?.push(part);
        }
      },
      run,
      stop: () => connection?.close(),
      subscribeChild: async (threadId) => {
        if (threadId === parentThreadId || subscribedChildren.has(threadId)) {
          return;
        }
        subscribedChildren.add(threadId);
        const resumed = record(
          await connection?.request("thread/resume", {
            excludeTurns: true,
            initialTurnsPage: { itemsView: "notLoaded", limit: 1 },
            threadId,
          })
        );
        const turns = record(resumed.initialTurnsPage).data;
        if (!Array.isArray(turns)) {
          return;
        }
        for (const value of turns) {
          const turn = record(value);
          if (turn.status === "inProgress" && typeof turn.id === "string") {
            await events?.receive("turn/started", { threadId, turn });
          }
        }
      },
    });
    connection = new AppServerConnection(
      child,
      processAbort.signal,
      receive,
      async (error) => {
        const closedEvents = events;
        processAbort?.abort(error);
        connection = undefined;
        events = undefined;
        subscribedChildren.clear();
        childTurns.clear();
        parentThreadId = undefined;
        if (running) {
          queue?.push({ error, type: "error" });
        }
        finishTurn();
        await closedEvents?.close();
      }
    );
    await connection.request("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: { name: "foundry", title: "Foundry", version: "0.1.0" },
    });
    connection.notify("initialized");
    await authenticate(connection, options);
  };
  return {
    capabilities: { interruption: true, steering: true },
    async close() {
      const liveEvents = events;
      connection?.close();
      processAbort?.abort();
      await liveEvents?.close();
    },
    id: "codex",
    async interrupt() {
      if (connection && turnId && parentThreadId) {
        await connection.request("turn/interrupt", {
          threadId: parentThreadId,
          turnId,
        });
      }
      connection?.close(new Error("Codex turn interrupted."));
    },
    async run(run) {
      if (running) {
        throw new Error("Codex driver already has an active turn.");
      }
      run.signal.throwIfAborted();
      const sandbox = codexSandbox(run.profile, options.sandboxPolicy);
      // Refused before any process starts: only text crosses to the CLI.
      const text = inputText(run.input);
      running = true;
      currentRun = run;
      queue = eventStream<StreamPart>();
      try {
        if (!connection) {
          await startProcess(run);
        }
        const liveConnection = connection;
        if (!liveConnection) {
          throw new Error("Codex app-server exited during initialization.");
        }
        events?.setRun(run);
        removeTurnAbort?.();
        const abort = () =>
          liveConnection.close(new Error("Codex turn canceled."));
        run.signal.addEventListener("abort", abort, { once: true });
        removeTurnAbort = () => run.signal.removeEventListener("abort", abort);
        if (run.signal.aborted) {
          abort();
        }
        const resumeId = parentThreadId ?? run.nativeSessionId;
        const threadIdentity = await threadParameters(run, resumeId);
        const started = record(
          await liveConnection.request(
            resumeId ? "thread/resume" : "thread/start",
            {
              ...turnDefaults,
              developerInstructions: options.instructions ?? "",
              sandbox,
              ...threadIdentity,
            }
          )
        );
        const threadId = record(started.thread).id;
        if (typeof threadId !== "string" || !threadId) {
          throw new Error("Codex app-server did not return a thread id.");
        }
        parentThreadId = threadId;
        await run.onSessionId(threadId);
        const turn = record(
          await liveConnection.request("turn/start", {
            ...turnDefaults,
            input: [{ text, text_elements: [], type: "text" }],
            sandboxPolicy:
              sandbox === "read-only"
                ? { type: "readOnly" }
                : {
                    excludeSlashTmp: true,
                    excludeTmpdirEnvVar: true,
                    networkAccess: true,
                    type: "workspaceWrite",
                    writableRoots: [options.cwd],
                  },
            threadId,
          })
        );
        updateTurn(turn);
        return queue.stream;
      } catch (error) {
        connection?.close();
        finishTurn();
        throw error;
      }
    },
    async steer(input) {
      if (!(connection && turnId && parentThreadId && running)) {
        throw new Error("Codex has no active turn to steer.");
      }
      await connection.request("turn/steer", {
        expectedTurnId: turnId,
        input: [{ text: input, text_elements: [], type: "text" }],
        threadId: parentThreadId,
      });
    },
    async stopActivity(id) {
      const threadId = events?.stoppableNativeId(id);
      const childTurn = threadId ? childTurns.get(threadId) : undefined;
      if (!(connection && threadId && childTurn)) {
        throw new Error("Codex subagent has no controllable active turn.");
      }
      await connection.request("turn/interrupt", {
        threadId,
        turnId: childTurn.turnId,
      });
      childTurn.abort.abort(new Error("Codex subagent turn interrupted."));
    },
  };
}

async function threadParameters(run: DriverRun, resumeId?: string) {
  if (resumeId) {
    return { threadId: resumeId };
  }
  if (run.tools) {
    return { dynamicTools: await dynamicTools(run) };
  }
  return {};
}
