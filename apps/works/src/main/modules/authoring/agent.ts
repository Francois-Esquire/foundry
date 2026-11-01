import { MODULE_SETTING_HOST_POLICY } from "@foundry/modules/settings";
import type { Container } from "@foundry/sandbox/container/containers";
import type {
  SandboxAgentOptions,
  SessionEvent,
  TaskContext,
} from "@foundry.sh/marbles/engine";
import type { AuthoringRoute } from "~/shared/authoring";
import { authoringGuest } from "./guest";

/**
 * One authoring turn's Agent Session: the built-in coding harness on a
 * network model, opened through the run's own agents so its model turns
 * and tool calls are recorded on the run, working inside the borrowed
 * Module sandbox with the shared Marbles guest coding tools.
 */

/**
 * The `authoring.deadline` and `authoring.maxSteps` settings' host defaults
 * (spec §10); a Module's settings choose its own within the ceilings.
 */
export const AUTHORING_LIMITS = {
  /** A turn's deadline, distinct from the sandbox's lifetime. */
  deadlineMs: MODULE_SETTING_HOST_POLICY["authoring.deadline"].default,
  maxSteps: MODULE_SETTING_HOST_POLICY["authoring.maxSteps"].default,
} as const;

const AUTHORING_AGENT_ID = "works-authoring";

/**
 * Tools the engine offers a sandboxed agent that a Works authoring turn must
 * never use. They stay advertised, so an attempt is denied, not hidden.
 */
export const AUTHORING_DISALLOWED_TOOLS = [
  "create_automation",
  "delete_automation",
  "list_automation_targets",
  "list_automations",
  "set_automation_enabled",
  "delegate",
] as const;

/** Scratch-container coding: the guest tools run without asking; the rest is denied or asked. */
function authoringProfile(
  maxSteps: number
): NonNullable<SandboxAgentOptions["profile"]> {
  return {
    allowedTools: ["read", "write", "edit", "glob", "grep", "bash"],
    disallowedTools: AUTHORING_DISALLOWED_TOOLS,
    maxSteps,
    mode: "attended",
    unresolved: "ask",
  };
}

const INSTRUCTIONS = [
  "You are editing the source of a Foundry Works Module, a small web app, in the workspace.",
  "The workspace holds a scratch copy of the user's current draft. Your file changes are offered to the user as a proposal to review; nothing you do saves the Module.",
  "Each request starts again from the user's latest draft, so changes from an earlier request may be absent if the user did not accept them.",
  "foundry.module.json is the Module Manifest; keep it valid.",
  "Use ask_user when you need a decision from the user.",
].join("\n");

export type AuthoringQuestionHandler = NonNullable<
  SandboxAgentOptions["question"]
>;
export type AuthoringApprovalHandler = NonNullable<
  NonNullable<SandboxAgentOptions["authority"]>["approve"]
>;

export interface AuthoringTurnRun {
  /** Live approvals, routed to the owning chat. */
  readonly approve: AuthoringApprovalHandler;
  readonly container: Container;
  readonly context: TaskContext;
  readonly maxSteps: number;
  readonly onEvent: (event: SessionEvent) => void;
  readonly prompt: string;
  /** `ask_user`, routed to the owning chat. */
  readonly question: AuthoringQuestionHandler;
  readonly route: AuthoringRoute;
  /** The Agent Session to continue, or to start under this id. */
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

/** Runs the agent; scratch files are what it leaves in the workspace. */
export type AuthoringTurnRunner = (run: AuthoringTurnRun) => Promise<void>;

export const runAuthoringAgent: AuthoringTurnRunner = async (run) => {
  const session = await run.context.agents.session(
    {
      id: AUTHORING_AGENT_ID,
      kind: "agent",
      model: run.route.model,
      prompt: INSTRUCTIONS,
      provider: run.route.provider,
    },
    {
      authority: { approve: run.approve },
      profile: authoringProfile(run.maxSteps),
      question: run.question,
      sandbox: run.context.sandbox(authoringGuest(run.container)),
      session: { id: run.sessionId, provider: run.route.provider },
    }
  );
  const stream = session.stream(run.prompt, { signal: run.signal });
  for await (const event of stream) {
    run.onEvent(event);
  }
  await stream.message;
};
