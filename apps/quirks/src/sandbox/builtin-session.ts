import { createInMemoryAgentAuthorizer } from "@foundry/agents/authorization";
import type {
  HarnessPermissionProfile,
  HarnessSession,
} from "@foundry/agents/harness";
import {
  createBuiltinCodingHarness,
  createHarnessPermission,
} from "@foundry/agents/harness";
import { createModelSummarizer } from "@foundry/agents/session";
import type { Container } from "@foundry/sandbox/container/containers";

import { createCodingTools } from "./coding-tools";
import type { SandboxSessionSettings } from "./session";

export async function createBuiltinSession(
  settings: SandboxSessionSettings,
  container: Container,
  profile: HarnessPermissionProfile
): Promise<HarnessSession> {
  const { model, options } = settings;
  if (!model) {
    throw new Error(
      "A registered network model is required for built-in coding."
    );
  }
  const policy =
    options.authority?.policy ?? createInMemoryAgentAuthorizer().authorizer;
  const permission = createHarnessPermission({
    agentId: settings.agentId,
    policy,
    profile,
    store: settings.store,
    ...(options.authority?.approve
      ? { approve: options.authority.approve }
      : {}),
    onApprovalRequest(request) {
      settings.write({ request, type: "harness-approval" });
      options.authority?.onApprovalRequest?.(request);
    },
  });
  return createBuiltinCodingHarness(
    {
      agentId: settings.agentId,
      compaction: {
        summarizer: createModelSummarizer({ model }),
        ...(typeof options.compaction === "object" ? options.compaction : {}),
      },
      instructions: settings.instructions,
      maxSteps: profile.maxSteps,
      model,
      permission,
      policy,
      sessionId: settings.sessionId,
      store: settings.store,
      tools: createCodingTools(container, { workspacePath: "/workspace" }),
    },
    { sessionId: settings.sessionId }
  );
}
