import type {
  Capability,
  HarnessPermissionRequest,
  ToolSource,
} from "@foundry/core/agents";
import type { ModelMessage, Tool } from "ai";

const TOOL_META = Symbol.for("foundry.tool-meta");

interface ToolMeta {
  capability?: (
    input: unknown,
    context: {
      agentId: string;
      messages: ModelMessage[];
      sessionId: string;
      toolCallId: string;
    }
  ) => Capability;
  source?: ToolSource;
}

export function toolPermissionMeta(
  tool: Tool | undefined,
  context: {
    agentId: string;
    input: unknown;
    sessionId: string;
    toolCallId: string;
  }
): Pick<HarnessPermissionRequest, "capability" | "source"> {
  if (!tool) {
    return {};
  }
  const meta = (tool as Tool & { [TOOL_META]?: ToolMeta })[TOOL_META];
  if (!meta) {
    return {};
  }
  const capability =
    typeof meta.capability === "function"
      ? meta.capability(context.input, {
          agentId: context.agentId,
          messages: [],
          sessionId: context.sessionId,
          toolCallId: context.toolCallId,
        })
      : undefined;
  return {
    ...(capability ? { capability } : {}),
    ...(meta.source ? { source: meta.source } : {}),
  };
}
