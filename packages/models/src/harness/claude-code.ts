import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { HarnessTurnDriver } from "@foundry/agents/harness";
import {
  type ClaudeCodeQueryController,
  type ClaudeCodeSettings,
  createAiSdkMcpServer,
  createClaudeCode,
  type MessageInjector,
} from "ai-sdk-provider-claude-code";
import { inputSummary, inputText, record } from "./shared";

export interface ClaudeCodeDriverOptions {
  agentId: string;
  /** Internal transport seam, also used by native protocol contract tests. */
  createModel?: (
    modelId: string,
    settings: ClaudeCodeSettings
  ) => LanguageModelV4;
  cwd: string;
  modelId: string;
  settings?: ClaudeCodeSettings;
  /** Injected by the host. The launcher must execute the Linux CLI in its VM. */
  spawnClaudeCodeProcess: NonNullable<
    ClaudeCodeSettings["spawnClaudeCodeProcess"]
  >;
}

/** The community provider transports one CLI loop; Foundry never wraps it in another loop. */
export function createClaudeCodeDriver(
  options: ClaudeCodeDriverOptions
): HarnessTurnDriver {
  let controller: ClaudeCodeQueryController | undefined;
  let injector: MessageInjector | undefined;
  let active: AbortController | undefined;
  const modelFactory =
    options.createModel ??
    ((modelId, settings) =>
      createClaudeCode().languageModel(modelId, settings));

  return {
    capabilities: { interruption: true, steering: true },
    async close() {
      active?.abort();
    },
    id: "claude-code",
    async interrupt() {
      active?.abort();
      await controller?.interrupt();
    },
    async run(run) {
      if (active) {
        throw new Error("Claude Code driver already has an active turn.");
      }
      const abort = new AbortController();
      active = abort;
      const forwardAbort = () => abort.abort(run.signal.reason);
      if (run.signal.aborted) {
        forwardAbort();
      }
      run.signal.addEventListener("abort", forwardAbort, { once: true });
      const seen = new Set<string>();
      let { nativeSessionId } = run;
      const emit = async (
        toolName: string,
        toolCallId: string,
        input: unknown,
        outcome: "started" | "ran" | "refused" | "failed",
        reason?: string
      ) => {
        const key = `${toolCallId}:${outcome}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        await run.onToolEvent({
          agentId: options.agentId,
          harness: "claude-code",
          inputSummary: inputSummary(input),
          outcome,
          sessionId: run.sessionId,
          toolCallId,
          toolName,
          ...(reason ? { reason } : {}),
        });
      };
      const hook =
        (outcome: "started" | "ran" | "failed") =>
        async (...args: unknown[]) => {
          const data = record(args[0]);
          const toolName = String(data.tool_name ?? "unknown");
          const toolCallId = String(data.tool_use_id ?? args[1] ?? "unknown");
          await emit(
            toolName,
            toolCallId,
            data.tool_input,
            outcome,
            outcome === "failed" ? "CLI tool failed" : undefined
          );
          if (outcome === "started") {
            const result = await run.permission({
              input: data.tool_input,
              sessionId: run.sessionId,
              signal: abort.signal,
              toolCallId,
              toolName: permissionToolName(toolName, run.tools),
            });
            if (result.behavior === "deny") {
              await emit(
                toolName,
                toolCallId,
                data.tool_input,
                "refused",
                result.message
              );
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: result.message,
                },
              };
            }
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                ...(result.updatedInput === undefined
                  ? {}
                  : { updatedInput: result.updatedInput }),
              },
            };
          }
          return {};
        };
      const settings: ClaudeCodeSettings = {
        ...options.settings,
        allowedTools: [...run.profile.allowedTools],
        canUseTool: async (toolName, input, context) => {
          const result = await run.permission({
            input,
            sessionId: run.sessionId,
            signal: AbortSignal.any([abort.signal, context.signal]),
            suggestions: context.suggestions,
            title: context.title,
            toolCallId: context.toolUseID,
            toolName: permissionToolName(toolName, run.tools),
          });
          if (result.behavior === "deny") {
            await emit(
              toolName,
              context.toolUseID,
              input,
              "refused",
              result.message
            );
            return result;
          }
          return {
            behavior: "allow",
            updatedInput: record(result.updatedInput ?? input),
          };
        },
        continue: false,
        cwd: options.cwd,
        disallowedTools: [...run.profile.disallowedTools],
        hooks: {
          PostToolUse: [{ hooks: [hook("ran")] }],
          PostToolUseFailure: [{ hooks: [hook("failed")] }],
          PreToolUse: [{ hooks: [hook("started")] }],
        },
        logger: false,
        maxTurns: run.profile.maxSteps,
        onQueryControllerCreated: (value) => {
          controller = value;
        },
        onSdkMessage: async (message) => {
          const data = record(message);
          if (
            typeof data.session_id === "string" &&
            data.session_id &&
            data.session_id !== nativeSessionId
          ) {
            nativeSessionId = data.session_id;
            await run.onSessionId(nativeSessionId);
          }
          if (Array.isArray(data.permission_denials)) {
            for (const denied of data.permission_denials) {
              const denial = record(denied);
              await emit(
                String(denial.tool_name ?? "unknown"),
                String(denial.tool_use_id ?? "unknown"),
                denial.tool_input,
                "refused",
                "CLI permission policy refused the tool call"
              );
            }
          }
          if (data.type === "system" && data.subtype === "permission_denied") {
            await emit(
              String(data.tool_name ?? "unknown"),
              String(data.tool_use_id ?? "unknown"),
              data.tool_input,
              "refused",
              "CLI permission policy refused the tool call"
            );
          }
        },
        onStreamStart: (value) => {
          injector = value;
        },
        permissionMode:
          run.profile.unresolved === "ask" && run.profile.mode === "attended"
            ? "default"
            : "dontAsk",
        resume: run.nativeSessionId,
        // No sdkOptions overlay may silently replace the run's declared authority.
        sdkOptions: undefined,
        sessionId: undefined,
        sessionStore: undefined,
        settingSources: [],
        spawnClaudeCodeProcess: options.spawnClaudeCodeProcess,
        streamingInput: "always",
        ...(run.tools
          ? {
              mcpServers: {
                foundry: createAiSdkMcpServer("foundry", run.tools),
              },
            }
          : {}),
      };
      try {
        const model = modelFactory(options.modelId, settings);
        const result = await model.doStream({
          abortSignal: abort.signal,
          prompt: [
            {
              content: [{ text: inputText(run.input), type: "text" }],
              role: "user",
            },
          ],
        });
        return consume(result.stream, () => {
          run.signal.removeEventListener("abort", forwardAbort);
          active = undefined;
          controller = undefined;
          injector = undefined;
        });
      } catch (error) {
        active = undefined;
        run.signal.removeEventListener("abort", forwardAbort);
        throw error;
      }
    },
    steer(input) {
      if (!injector) {
        throw new Error("Claude Code has no active turn to steer.");
      }
      return new Promise<void>((resolve, reject) => {
        injector?.inject(input, (delivered) =>
          delivered
            ? resolve()
            : reject(
                new Error(
                  "Claude Code turn ended before steering was delivered."
                )
              )
        );
      });
    },
  };
}

function permissionToolName(
  toolName: string,
  tools: Parameters<HarnessTurnDriver["run"]>[0]["tools"]
): string {
  const prefix = "mcp__foundry__";
  const localName = toolName.startsWith(prefix)
    ? toolName.slice(prefix.length)
    : toolName;
  return tools?.[localName] ? localName : toolName;
}

async function* consume(stream: ReadableStream<unknown>, finish: () => void) {
  const reader = stream.getReader();
  try {
    let item = await reader.read();
    while (!item.done) {
      const part = record(item.value);
      if (
        part.type === "text-delta" ||
        part.type === "reasoning-delta" ||
        part.type === "text-end" ||
        part.type === "reasoning-end"
      ) {
        yield { ...part, type: String(part.type) };
      } else if (part.type === "error") {
        yield {
          error: new Error(
            "Claude Code turn failed; raw CLI diagnostics are withheld."
          ),
          type: "error",
        };
      } else if (part.type === "finish") {
        yield { type: "finish", usage: part.usage };
      }
      item = await reader.read();
    }
  } finally {
    reader.releaseLock();
    finish();
  }
}
