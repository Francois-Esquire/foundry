import type { HarnessTurnDriver, StreamPart } from "@foundry/agents/harness";
import { AppServerConnection, type CliProcess } from "./app-server";
import {
  authenticate,
  codexSandbox,
  refreshSubscription,
} from "./codex-authorization";
import { createCodexEvents } from "./codex-events";
import { answerRequest, dynamicTools } from "./codex-tools";
import { eventStream, inputText, record } from "./shared";

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

export function createCodexDriver(
  options: CodexDriverOptions
): HarnessTurnDriver {
  const state: { running: boolean } = { running: false };
  let active:
    | { connection: AppServerConnection; threadId: string; turnId?: string }
    | undefined;
  return {
    capabilities: { interruption: true, steering: true },
    async close() {
      active?.connection.close();
      active = undefined;
    },
    id: "codex",
    async interrupt() {
      if (active?.turnId) {
        await active.connection.request("turn/interrupt", {
          threadId: active.threadId,
          turnId: active.turnId,
        });
      }
      active?.connection.close(new Error("Codex turn interrupted."));
      active = undefined;
    },
    async run(run) {
      if (state.running) {
        throw new Error("Codex driver already has an active turn.");
      }
      const sandbox = codexSandbox(run.profile, options.sandboxPolicy);
      inputText(run.input);
      state.running = true;
      const queue = eventStream<StreamPart>();
      let completed = false;
      const updateTurn = (params: Record<string, unknown>) => {
        const turn = record(params.turn);
        if (active && typeof turn.id === "string") {
          active.turnId = turn.id;
        }
      };
      let connection: AppServerConnection;
      const events = createCodexEvents({
        agentId: options.agentId,
        onComplete: () => {
          completed = true;
          queue.close();
          connection.close();
          active = undefined;
        },
        onTurn: updateTurn,
        push: queue.push,
        run,
        stop: () => connection.close(),
      });
      const child = await launch(options, run.signal, () => {
        state.running = false;
      });
      connection = new AppServerConnection(
        child,
        run.signal,
        async (method, params, id) => {
          if (id !== undefined) {
            if (method === "account/chatgptAuthTokens/refresh") {
              await refreshSubscription(
                connection,
                params,
                id,
                options,
                run.signal
              );
              return;
            }
            await answerRequest(
              connection,
              method,
              params,
              id,
              run,
              events.emit
            );
            return;
          }
          await events.receive(method, params);
        },
        (error) => {
          if (!completed) {
            queue.push({ error, type: "error" });
            queue.close();
          }
          active = undefined;
          state.running = false;
        }
      );
      try {
        await connection.request("initialize", {
          capabilities: { experimentalApi: true },
          clientInfo: { name: "foundry", title: "Foundry", version: "0.1.0" },
        });
        connection.notify("initialized");
        await authenticate(connection, options);
        const approvalPolicy = "untrusted";
        const params = {
          approvalPolicy,
          approvalsReviewer: "user",
          cwd: options.cwd,
          developerInstructions: options.instructions ?? "",
          model: options.modelId,
          sandbox,
          ...(!run.nativeSessionId && run.tools
            ? { dynamicTools: await dynamicTools(run) }
            : {}),
        };
        const started = record(
          await connection.request(
            run.nativeSessionId ? "thread/resume" : "thread/start",
            {
              ...params,
              ...(run.nativeSessionId ? { threadId: run.nativeSessionId } : {}),
            }
          )
        );
        const threadId = String(record(started.thread).id ?? "");
        if (!threadId) {
          throw new Error("Codex app-server did not return a thread id.");
        }
        await run.onSessionId(threadId);
        active = { connection, threadId };
        const turn = record(
          await connection.request("turn/start", {
            approvalPolicy,
            approvalsReviewer: "user",
            cwd: options.cwd,
            input: [
              { text: inputText(run.input), text_elements: [], type: "text" },
            ],
            model: options.modelId,
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
        connection.close();
        throw error;
      }
    },
    async steer(input) {
      if (!active?.turnId) {
        throw new Error("Codex has no active turn to steer.");
      }
      await active.connection.request("turn/steer", {
        expectedTurnId: active.turnId,
        input: [{ text: input, text_elements: [], type: "text" }],
        threadId: active.threadId,
      });
    },
  };
}

async function launch(
  options: CodexDriverOptions,
  signal: AbortSignal,
  failed: () => void
): Promise<CliProcess> {
  try {
    return await options.spawn([options.binPath, "app-server"], {
      cwd: options.cwd,
      env: options.env ?? {},
      signal,
    });
  } catch (error) {
    failed();
    throw error;
  }
}
