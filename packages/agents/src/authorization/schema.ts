import type { Exactly } from "@foundry/lib/exactly";
import { z } from "zod";

import type { AgentSubject } from "./authorization";
import { AGENT_SUBJECT_NAMESPACE } from "./authorization";
import type { Capability, ToolSource } from "./capability";

const toolSources = z.enum([
  "declared",
  "builtin",
  "skill",
  "mcp",
  "mesh",
  "module",
  "harness",
]);

const capability = z.discriminatedUnion("kind", [
  z.strictObject({ domain: z.string(), kind: z.literal("web.fetch") }),
  z.strictObject({
    kind: z.literal("mcp.tool"),
    serverId: z.string(),
    tool: z.string(),
  }),
  z.strictObject({
    kind: z.literal("fs.read"),
    projectId: z.string(),
    root: z.string(),
  }),
  z.strictObject({
    command: z.strictObject({ id: z.string(), version: z.int().nonnegative() }),
    domain: z.string(),
    effect: z.enum(["read", "compute", "write"]),
    kind: z.literal("domain.command"),
    target: z.strictObject({ projectId: z.string(), scope: z.string() }),
  }),
  z.strictObject({
    kind: z.literal("tool.call"),
    source: toolSources,
    tool: z.string(),
  }),
]);

const subject = z.strictObject({
  id: z.string(),
  namespace: z.literal(AGENT_SUBJECT_NAMESPACE),
  version: z.int().nonnegative().optional(),
});

export const toolSourceSchema: z.ZodType<
  Exactly<z.infer<typeof toolSources>, ToolSource>
> = toolSources;

export const capabilitySchema: z.ZodType<
  Exactly<z.infer<typeof capability>, Capability>
> = capability;

export const agentSubjectSchema: z.ZodType<
  Exactly<z.infer<typeof subject>, AgentSubject>
> = subject;
