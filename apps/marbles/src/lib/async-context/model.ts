import type { Models } from "@foundry/models";
import type { Output } from "ai";
import type { AgentLike } from "~/lib/definitions/types";

export interface ExecutionContext {
  readonly agentIdOf?: (agent: AgentLike<Output.Output>) => string | undefined;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly models?: Models | undefined;
  readonly spawned?: string;
  readonly workspaceId: string;
}
