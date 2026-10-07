import type { Exactly } from "@foundry/lib/exactly";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentSubject } from "../../authorization/authorization";
import { agentSubject } from "../../authorization/authorization";
import type { Capability } from "../../authorization/capability";
import {
  agentSubjectSchema,
  capabilitySchema,
} from "../../authorization/schema";

const EVERY_KIND: readonly Capability[] = [
  { domain: "example.com", kind: "web.fetch" },
  { kind: "mcp.tool", serverId: "server", tool: "read" },
  { kind: "fs.read", projectId: "project", root: "/workspace" },
  {
    command: { id: "update", version: 2 },
    domain: "issues",
    effect: "write",
    kind: "domain.command",
    target: { projectId: "project", scope: "issue" },
  },
  { kind: "tool.call", source: "harness", tool: "shell" },
];

describe("capabilitySchema", () => {
  it.each(EVERY_KIND)("reads back a $kind capability unchanged", (value) => {
    expect(capabilitySchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(
      value
    );
  });

  it("refuses unknown keys and unknown tool sources", () => {
    expect(
      capabilitySchema.safeParse({
        domain: "example.com",
        kind: "web.fetch",
        secret: "x",
      }).success
    ).toBe(false);
    expect(
      capabilitySchema.safeParse({
        kind: "tool.call",
        source: "elsewhere",
        tool: "t",
      }).success
    ).toBe(false);
  });
});

describe("agentSubjectSchema", () => {
  it("reads agent subjects and refuses other namespaces", () => {
    const subject = { id: "helper", namespace: "agent", version: 3 };
    expect(agentSubjectSchema.parse(subject)).toEqual(subject);
    expect(
      agentSubjectSchema.parse({ id: "helper", namespace: "agent" })
    ).toEqual({ id: "helper", namespace: "agent" });
    expect(
      agentSubjectSchema.safeParse({ id: "helper", namespace: "module" })
        .success
    ).toBe(false);
  });

  it("pins the schemas to their types at compile time", () => {
    const missingKind = z.discriminatedUnion("kind", [
      z.strictObject({ domain: z.string(), kind: z.literal("web.fetch") }),
    ]);
    const extraField = z.strictObject({
      id: z.string(),
      namespace: z.literal("agent"),
      owner: z.string(),
    });
    // @ts-expect-error A schema missing a Capability kind collapses to never.
    const capability: z.ZodType<
      Exactly<z.infer<typeof missingKind>, Capability>
    > = missingKind;
    // @ts-expect-error A schema requiring a field AgentSubject lacks collapses to never.
    const subject: z.ZodType<
      Exactly<z.infer<typeof extraField>, AgentSubject>
    > = extraField;
    expect([capability, subject]).toEqual([missingKind, extraField]);
  });

  it("accepts what agentSubject builds once serialized", () => {
    const subject = agentSubject("helper");
    expect(
      agentSubjectSchema.parse(JSON.parse(JSON.stringify(subject)))
    ).toEqual({ id: "helper", namespace: "agent" });
  });
});
