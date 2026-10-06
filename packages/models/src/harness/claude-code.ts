import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { HarnessTurnDriver } from "@foundry/agents/harness";
import {
  type ClaudeCodeQueryController,
  type ClaudeCodeSettings,
  createAiSdkMcpServer,
  createClaudeCode,
  type MessageInjector,
} from "ai-sdk-provider-claude-code";
import {
  claudeActivityHooks,
  claudeMessages,
  consume,
} from "./claude-code-events";
import { createClaudeTools } from "./claude-code-tools";
import {
  createNativeActivities,
  type NativeActivities,
} from "./native-activity";
import { inputText } from "./shared";

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
  let activities: NativeActivities | undefined;
  const modelFactory =
    options.createModel ??
    ((modelId, settings) =>
      createClaudeCode().languageModel(modelId, settings));

  return {
    capabilities: { interruption: true, steering: true },
    async close() {
      active?.abort();
      await activities?.close();
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
      const runActivities = createNativeActivities(run, crypto.randomUUID());
      activities = runActivities;
      const tools = createClaudeTools({
        activities: runActivities,
        agentId: options.agentId,
        run,
        signal: abort.signal,
      });
      // The turn stays active until its activities have closed, so a next
      // turn cannot start while this one's activities are still settling.
      const finish = async () => {
        await runActivities.close();
        activities = undefined;
        run.signal.removeEventListener("abort", forwardAbort);
        active = undefined;
        controller = undefined;
        injector = undefined;
      };
      const settings: ClaudeCodeSettings = {
        ...options.settings,
        allowedTools: [...run.profile.allowedTools],
        canUseTool: tools.canUseTool,
        continue: false,
        cwd: options.cwd,
        disallowedTools: [...run.profile.disallowedTools],
        hooks: { ...tools.hooks, ...claudeActivityHooks(runActivities) },
        logger: false,
        maxTurns: run.profile.maxSteps,
        onQueryControllerCreated: (value) => {
          controller = value;
        },
        onSdkMessage: claudeMessages(run, runActivities, tools.report),
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
        return consume(result.stream, finish);
      } catch (error) {
        await finish();
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
    async stopActivity(id) {
      const taskId = activities?.taskId(id);
      if (!(taskId && controller)) {
        throw new Error("Claude Code task is no longer controllable.");
      }
      await controller.stopTask(taskId);
    },
  };
}
