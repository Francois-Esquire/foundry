/**
 * Runtime schemas for the agent authorization vocabulary, for hosts that read
 * a {@link Capability} or {@link AgentSubject} back from storage.
 *
 * Strict on purpose: a saved value with a key this vocabulary does not define
 * is refused, not stripped, so a durable grant store fails closed on anything
 * it did not write. The types stay hand-written (they carry the documentation)
 * and each schema is checked against its type at compile time, so the two
 * cannot drift.
 */

import { z } from "zod";

import type { AgentSubject } from "./authorization";
import { AGENT_SUBJECT_NAMESPACE } from "./authorization";
import type { Capability } from "./capability";

/**
 * `T` when the schema's output and `T` are assignable both ways, else
 * `never` — which makes the annotated schema constant fail to typecheck.
 */
type Exactly<Output, T> = [Output] extends [T]
  ? [T] extends [Output]
    ? T
    : never
  : never;

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

/** A saved {@link Capability}. */
export const capabilitySchema: z.ZodType<
  Exactly<z.infer<typeof capability>, Capability>
> = capability;

/** A saved {@link AgentSubject}. */
export const agentSubjectSchema: z.ZodType<
  Exactly<z.infer<typeof subject>, AgentSubject>
> = subject;
