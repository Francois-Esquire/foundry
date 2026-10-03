import type { Instructions, ToolSet } from "ai";
import { stepCountIs } from "ai";
import type { TurnContext } from "../agents/loop-agent";
import type { AgentAuthorizer } from "../authorization";
import type { SessionInput, SessionMessage } from "../session";
import type {
  SessionHarnessSettings,
  SessionStreamOptions,
} from "./session-harness";
import { SessionHarness } from "./session-harness";
import type { HarnessSession } from "./turn-driver";

export const CODING_INSTRUCTIONS =
  "You are a coding agent working in the supplied workspace. Read the relevant files and project instructions before editing. Use read, write, edit, grep, glob, and bash tools when provided. Make focused changes, preserve unrelated work, and run checks appropriate to the change. Treat a denied tool result as a refusal and choose an allowed route. Never claim a command or test ran unless its tool result confirms it. Report the changed behavior, verification, and remaining gaps.";

export type BuiltinCodingSettings = Omit<
  SessionHarnessSettings,
  "tools" | "stopWhen" | "compaction"
> & {
  agentId: string;
  policy: AgentAuthorizer;
  tools: ToolSet;
  maxSteps: number;
  compaction: NonNullable<SessionHarnessSettings["compaction"]>;
};

/** The host supplies coding tools and their execution environment. No Sandbox dependency. */
export function createBuiltinCodingHarness(
  settings: BuiltinCodingSettings,
  context: TurnContext
): HarnessSession {
  if (!Number.isSafeInteger(settings.maxSteps) || settings.maxSteps < 1) {
    throw new Error("Coding maxSteps must be a positive safe integer.");
  }
  const { maxSteps, instructions, ...rest } = settings;
  const harness = new SessionHarness(
    {
      ...rest,
      instructions: codingInstructions(instructions),
      stopWhen: stepCountIs(maxSteps),
    },
    context
  );
  let active: AbortController | undefined;
  let activeMessage: Promise<SessionMessage> | undefined;
  let closed = false;
  const stream = (input: SessionInput, options: SessionStreamOptions = {}) => {
    if (closed) {
      throw new Error("Coding session is closed.");
    }
    if (active) {
      throw new Error("A coding session can run only one turn at a time.");
    }
    const controller = new AbortController();
    active = controller;
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const result = harness.stream(input, { ...options, signal });
    const settled = () => {
      if (active === controller) {
        active = undefined;
        activeMessage = undefined;
      }
    };
    activeMessage = result.message;
    result.message.then(settled, settled);
    return result;
  };
  return {
    capabilities: { interruption: true, steering: false },
    async close() {
      closed = true;
      const terminal = activeMessage;
      active?.abort(new Error("Coding session closed."));
      await terminal;
    },
    generate: (input, options) => stream(input, options).message,
    interrupt() {
      active?.abort(new Error("Coding turn interrupted."));
      return Promise.resolve();
    },
    route: harness.route,
    get sessionId() {
      return harness.sessionId;
    },
    steer() {
      return Promise.reject(
        new Error("Built-in coding does not support live steering.")
      );
    },
    store: harness.store,
    stream,
  };
}

function codingInstructions(
  instructions: Instructions | undefined
): Instructions {
  if (typeof instructions === "string" || instructions === undefined) {
    return [CODING_INSTRUCTIONS, instructions].filter(Boolean).join("\n\n");
  }
  return [
    { content: CODING_INSTRUCTIONS, role: "system" },
    ...(Array.isArray(instructions) ? instructions : [instructions]),
  ];
}
