import { MODULE_SETTING_HOST_POLICY } from "@foundry/modules/settings";
import type { Container } from "@foundry/sandbox/container/containers";
import type {
  SandboxAgentOptions,
  SessionEvent,
  TaskContext,
} from "@foundry.sh/marbles/engine";
import type { AuthoringRoute } from "~/shared/authoring";
import { authoringGuest } from "./guest";

export const AUTHORING_LIMITS = {
  deadlineMs: MODULE_SETTING_HOST_POLICY["authoring.deadline"].default,
  maxSteps: MODULE_SETTING_HOST_POLICY["authoring.maxSteps"].default,
} as const;

const AUTHORING_AGENT_ID = "works-authoring";

export const AUTHORING_DISALLOWED_TOOLS = [
  "create_automation",
  "delete_automation",
  "list_automation_targets",
  "list_automations",
  "set_automation_enabled",
  "delegate",
] as const;

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
  readonly approve: AuthoringApprovalHandler;
  readonly container: Container;
  readonly context: TaskContext;
  readonly maxSteps: number;
  readonly onEvent: (event: SessionEvent, policyDenied?: boolean) => void;
  readonly prompt: string;
  readonly question: AuthoringQuestionHandler;
  readonly route: AuthoringRoute;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export type AuthoringTurnRunner = (run: AuthoringTurnRun) => Promise<void>;

export const runAuthoringAgent: AuthoringTurnRunner = async (run) => {
  const { isPolicyDeniedOutput } = await import("@foundry.sh/marbles/engine");
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
    run.onEvent(
      event,
      event.type === "tool-result" && isPolicyDeniedOutput(event.output)
    );
  }
  await stream.message;
};
