import { createHash } from "node:crypto";
import type { HarnessTurnDriver, StreamPart } from "@foundry/core/agents";
import { validateHarnessProfile } from "@foundry/core/agents";
import type { CliProcess } from "../harness/cli-process";
import { eventStream } from "../harness/event-stream";
import { inputText, record } from "../harness/payload";
import { toolReporter } from "../harness/tool-report";
import { createPiEvents } from "./events";
import { PiRpc } from "./rpc";
import { type PiToolDefinition, piExtension, piTools } from "./tools";

export interface PiDriverOptions {
  agentId: string;
  binPath: string;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  instructions?: string;
  modelId: string;
  nativeTools?: readonly string[];
  persist?: boolean;
  sessionDirectory?: string;
  spawn(
    argv: readonly string[],
    options: {
      cwd: string;
      env: Readonly<Record<string, string>>;
      signal: AbortSignal;
    }
  ): Promise<CliProcess>;
  writeExtension(source: string): Promise<string>;
}

const NATIVE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const NATIVE_TOOLS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

export function createPiDriver(options: PiDriverOptions): HarnessTurnDriver {
  let active: { rpc?: PiRpc; abort: AbortController } | undefined;
  return {
    capabilities: { interruption: true, steering: true },
    async close() {
      active?.abort.abort();
      active?.rpc?.close();
    },
    id: "pi",
    async interrupt() {
      active?.abort.abort();
    },
    async run(run) {
      validateHarnessProfile(run.profile);
      run.signal.throwIfAborted();
      if (active) {
        throw new Error("Pi driver already has an active turn.");
      }
      const state = {
        abort: new AbortController(),
        rpc: undefined as PiRpc | undefined,
      };
      active = state;
      const signal = AbortSignal.any([run.signal, state.abort.signal]);
      const queue = eventStream<StreamPart>();
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        if (error) {
          queue.push(
            signal.aborted
              ? { reason: "Pi turn interrupted.", type: "abort" }
              : { error, type: "error" }
          );
        }
        queue.close();
      };
      const reporter = toolReporter(options.agentId, "pi", () => ({
        ...run,
        signal,
      }));
      const events = createPiEvents({
        agentId: options.agentId,
        close: () => state.rpc?.close(),
        finish,
        nativeTools: options.nativeTools,
        push: queue.push,
        report: reporter.report,
        run: { ...run, signal },
        send: async (message) => {
          await state.rpc?.send(message);
        },
      });
      try {
        const tools = await piTools(run);
        validatePiTools(tools, options.nativeTools ?? []);
        const [provider] = options.modelId.split("/");
        if (!(provider && options.modelId.includes("/"))) {
          throw new Error("Pi requires a provider/model id.");
        }
        const extension = await options.writeExtension(
          piExtension(
            tools,
            provider,
            options.instructions,
            options.nativeTools
          )
        );
        signal.throwIfAborted();
        const nativeId =
          run.nativeSessionId ??
          createHash("sha256").update(run.sessionId).digest("hex");
        if (!NATIVE_ID.test(nativeId)) {
          throw new Error("Invalid Pi session id.");
        }
        const child = await options.spawn(
          piArguments(options, tools, extension, nativeId),
          { cwd: options.cwd, env: options.env ?? {}, signal }
        );
        state.rpc = new PiRpc(
          child,
          signal,
          async (event) => {
            if (!finished) {
              await events.receive(event);
            }
          },
          (error) => finish(error)
        );
        const session = record(await state.rpc.request("get_state"));
        if (typeof session.sessionId !== "string") {
          throw new Error("Pi did not return a native session id.");
        }
        await run.onSessionId(session.sessionId);
        const guidance = run.responseFormat
          ? `\n\nReturn only JSON matching this schema: ${JSON.stringify(run.responseFormat.schema)}`
          : "";
        const accepted = record(
          await state.rpc.request("prompt", {
            message: `${inputText(run.input)}${guidance}`,
          })
        );
        if (accepted.disposition === "handled") {
          throw new Error(
            "Pi handled the input without starting an agent run."
          );
        }
      } catch (error) {
        state.rpc?.close();
        state.abort.abort();
        active = undefined;
        throw error;
      }
      return {
        async *[Symbol.asyncIterator]() {
          try {
            yield* queue.stream;
          } finally {
            finished = true;
            state.rpc?.close();
            state.abort.abort();
            if (active === state) {
              active = undefined;
            }
          }
        },
      };
    },
    async steer(message) {
      if (!active?.rpc) {
        throw new Error("Pi has no active turn to steer.");
      }
      await active.rpc.request("steer", { message });
    },
  };
}

function piArguments(
  options: PiDriverOptions,
  tools: PiToolDefinition[],
  extension: string,
  nativeId: string
): string[] {
  const names = [
    ...tools.map((tool) => tool.name),
    ...(options.nativeTools ?? []),
  ];
  return [
    options.binPath,
    "--mode",
    "rpc",
    "--model",
    options.modelId,
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-approve",
    "--extension",
    extension,
    ...(names.length
      ? [
          "--tools",
          names.join(","),
          ...(options.nativeTools?.length ? [] : ["--no-builtin-tools"]),
        ]
      : ["--no-tools"]),
    ...(options.persist === false
      ? ["--no-session"]
      : ["--session-id", nativeId]),
    ...(options.sessionDirectory
      ? ["--session-dir", options.sessionDirectory]
      : []),
  ];
}

function validatePiTools(
  tools: PiToolDefinition[],
  native: readonly string[]
): void {
  for (const name of native) {
    if (!NATIVE_TOOLS.has(name) || tools.some((tool) => tool.name === name)) {
      throw new Error(
        "Pi native tools must be known built-ins without host-tool name conflicts."
      );
    }
  }
}
