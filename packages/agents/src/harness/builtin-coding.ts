import type { Instructions } from "ai";
import { stepCountIs } from "ai";
import type { TurnContext } from "../agents/loop-agent";
import type { SessionInput } from "../session/events";
import type {
  SessionHarnessSettings,
  SessionStreamOptions,
} from "./session-harness";
import { SessionHarness } from "./session-harness";
import type { HarnessSession } from "./turn-driver";
import { validateHarnessProfile } from "./turn-driver";
import { createTurnGate } from "./turn-gate";

export const CODING_INSTRUCTIONS =
  "You are a coding agent working in the supplied workspace. Read the relevant files and project instructions before editing. Use read, write, edit, grep, glob, and bash tools when provided. Make focused changes, preserve unrelated work, and run checks appropriate to the change. Treat a denied tool result as a refusal and choose an allowed route. Never claim a command or test ran unless its tool result confirms it. Report the changed behavior, verification, and remaining gaps.";

export type BuiltinCodingSettings = Omit<
  SessionHarnessSettings,
  "tools" | "stopWhen" | "compaction"
> &
  Required<
    Pick<SessionHarnessSettings, "agentId" | "policy" | "tools" | "compaction">
  > & { maxSteps: number };

/** The host supplies coding tools and their execution environment. No Sandbox dependency. */
export function createBuiltinCodingHarness(
  settings: BuiltinCodingSettings,
  context: TurnContext
): HarnessSession {
  validateHarnessProfile(settings);
  const { maxSteps, instructions, ...rest } = settings;
  const harness = new SessionHarness(
    {
      ...rest,
      instructions: codingInstructions(instructions),
      stopWhen: stepCountIs(maxSteps),
    },
    context
  );
  const gate = createTurnGate("Coding");
  const stream = (input: SessionInput, options: SessionStreamOptions = {}) =>
    gate.run(options.signal, ({ signal }) =>
      harness.stream(input, { ...options, signal })
    );
  return {
    capabilities: { interruption: true, steering: false },
    async close() {
      await gate.close();
    },
    generate: (input, options) => stream(input, options).message,
    interrupt() {
      gate.interrupt();
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
