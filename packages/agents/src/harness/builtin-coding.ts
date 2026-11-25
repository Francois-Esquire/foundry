import { validateHarnessProfile } from "@foundry/core/agents";
import type { Instructions, Output } from "ai";
import { stepCountIs } from "ai";
import type { SessionInput } from "../session/events";
import type { HarnessSession } from "./harness-session";
import type { TurnContext } from "./loop-agent";
import type { SessionHarnessSettings, TurnOptions } from "./session-harness";
import { SessionHarness } from "./session-harness";
import { createTurnGate } from "./turn-gate";

export const CODING_INSTRUCTIONS =
  "You are a coding agent working in the supplied workspace. Read the relevant files and project instructions before editing. Use read, write, edit, grep, glob, and bash tools when provided. Make focused changes, preserve unrelated work, and run checks appropriate to the change. Treat a denied tool result as a refusal and choose an allowed route. Never claim a command or test ran unless its tool result confirms it. Report the changed behavior, verification, and remaining gaps.";

export type BuiltinCodingSettings = Omit<
  SessionHarnessSettings,
  "tools" | "stopWhen"
> &
  Required<Pick<SessionHarnessSettings, "agentId" | "policy" | "tools">> & {
    maxSteps: number;
  };

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
  const stream = <OUTPUT extends Output.Output = never>(
    input: SessionInput,
    options: TurnOptions<OUTPUT> = {}
  ) =>
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
