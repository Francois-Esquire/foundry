import { isHarnessQuestionTool } from "@foundry/agents/harness";
import { asSchema, type Tool } from "ai";
import { z } from "zod";
import type { DriverRun, ReportTool } from "./shared";

const TOOL_NAME = /^[a-zA-Z0-9_.-]+$/;

export interface PiToolDefinition {
  description: string;
  name: string;
  parameters: unknown;
}

export async function piTools(run: DriverRun): Promise<PiToolDefinition[]> {
  const definitions: PiToolDefinition[] = [];
  for (const [name, tool] of Object.entries(run.tools ?? {})) {
    if (!TOOL_NAME.test(name)) {
      throw new Error("Pi host tool names cannot contain selection patterns.");
    }
    if (!tool.execute) {
      throw new Error(`Pi host tool ${name} requires an execute function.`);
    }
    definitions.push({
      description:
        typeof tool.description === "string" ? tool.description : name,
      name,
      parameters: await asSchema(tool.inputSchema).jsonSchema,
    });
  }
  return definitions;
}

export async function executePiTool(
  run: DriverRun,
  report: ReportTool,
  request: { input: unknown; toolCallId: string; toolName: string }
): Promise<{ success: boolean; text: string }> {
  const tool =
    run.tools && Object.hasOwn(run.tools, request.toolName)
      ? run.tools[request.toolName]
      : undefined;
  await report({ ...request, outcome: "started" });
  try {
    run.signal.throwIfAborted();
    if (!tool?.execute) {
      throw new Error("Unknown host tool");
    }
    const permission = isHarnessQuestionTool(tool)
      ? { behavior: "allow" as const }
      : await run.permission({
          ...request,
          sessionId: run.sessionId,
          signal: run.signal,
        });
    if (permission.behavior === "deny") {
      await report({
        ...request,
        outcome: "refused",
        reason: permission.message,
      });
      return { success: false, text: permission.message };
    }
    const input = permission.updatedInput ?? request.input;
    const validated = await validateToolInput(tool, input);
    run.signal.throwIfAborted();
    const output = await tool.execute(validated, {
      abortSignal: run.signal,
      context: {},
      messages: [],
      toolCallId: request.toolCallId,
    });
    if (
      typeof output === "object" &&
      output !== null &&
      Symbol.asyncIterator in output
    ) {
      throw new Error("Streaming host tools are not supported by Pi.");
    }
    await report({ ...request, outcome: "ran" });
    return {
      success: true,
      text:
        typeof output === "string"
          ? output
          : (JSON.stringify(output) ?? "null"),
    };
  } catch {
    await report({ ...request, outcome: "failed", reason: "Host tool failed" });
    return { success: false, text: "Host tool failed" };
  }
}

async function validateToolInput(tool: Tool, input: unknown): Promise<unknown> {
  const schema = asSchema(tool.inputSchema);
  if (!schema.validate) {
    // Zod narrows the dialect string in its JSON Schema type; unsupported dialects fail at conversion.
    const json = (await schema.jsonSchema) as Parameters<
      typeof z.fromJSONSchema
    >[0];
    return z.fromJSONSchema(json).parse(input);
  }
  const validated = await schema.validate(input);
  if (!validated.success) {
    throw new Error("Invalid host tool arguments");
  }
  return validated.value;
}

/** Only this extension is loaded. Pi's own tools and resource discovery are disabled. */
export function piExtension(
  tools: PiToolDefinition[],
  provider: string,
  instructions?: string,
  nativeTools: readonly string[] = []
): string {
  return `export default function(pi) {
    const key = process.env.FOUNDRY_PI_API_KEY;
    if (key) pi.registerProvider(${JSON.stringify(provider)}, { apiKey: key });
    ${instructions ? `pi.on("before_agent_start", () => ({ systemPrompt: ${JSON.stringify(instructions)} }));` : ""}
    const native = ${JSON.stringify(nativeTools)};
    pi.on("tool_call", async (event, ctx) => {
      if (!native.includes(event.toolName)) return;
      const value = await ctx.ui.input("foundry.permission", JSON.stringify({ toolName: event.toolName, toolCallId: event.toolCallId, input: event.input }), { signal: ctx.signal });
      if (value === undefined) return { block: true, reason: "Host permission canceled" };
      const result = JSON.parse(value);
      if (!result.success) return { block: true, reason: result.text };
    });
    for (const tool of ${JSON.stringify(tools)}) {
      pi.registerTool({ ...tool, label: tool.name,
        async execute(toolCallId, input, signal, _update, ctx) {
          const value = await ctx.ui.input("foundry.execute", JSON.stringify({ toolName: tool.name, toolCallId, input }), { signal });
          if (value === undefined) throw new Error("Host tool canceled");
          const result = JSON.parse(value);
          if (!result.success) throw new Error(result.text);
          return { content: [{ type: "text", text: result.text }], details: undefined };
        }
      });
    }
  }\n`;
}
