import { describe, expect, it } from "vitest";

import type {
  Capability,
  CommandAuthorityDefinition,
} from "../../authorization/capability";

import {
  classifyCommandCapability,
  describeCapability,
} from "../../authorization/capability";

const ANALYSIS_EXECUTE = {
  command: { id: "analysis.execute", version: 1 },
  domain: "analysis",
  effect: "compute",
  kind: "domain.command",
  target: { projectId: "proj-1", scope: "code:proj-1" },
} as const satisfies Capability;

const KNOWN_COMMANDS = [
  {
    command: { id: "analysis.execute", version: 1 },
    domain: "analysis",
    effects: ["compute"],
  },
] as const satisfies readonly CommandAuthorityDefinition[];

describe("describeCapability", () => {
  it("names each kind readably, for audit lines and consent surfaces", () => {
    expect(
      describeCapability({ domain: "example.com", kind: "web.fetch" })
    ).toBe("web.fetch::example.com");
    expect(
      describeCapability({ kind: "mcp.tool", serverId: "s", tool: "t" })
    ).toBe("mcp.tool::s::t");
    expect(
      describeCapability({
        kind: "fs.read",
        projectId: "proj-1",
        root: "/Users/me/repo",
      })
    ).toBe("fs.read::proj-1::/Users/me/repo");
    expect(
      describeCapability({
        kind: "tool.call",
        source: "skill",
        tool: "notify",
      })
    ).toBe("tool.call::skill::notify");
    expect(describeCapability(ANALYSIS_EXECUTE)).toBe(
      'domain.command::["analysis","analysis.execute",1,"compute","proj-1","code:proj-1"]'
    );
  });
});

describe("classifyCommandCapability", () => {
  const fallback = { source: "declared", tool: "analyze" } as const;

  it("recognizes a structurally valid authority published by the command catalog", () => {
    expect(
      classifyCommandCapability(ANALYSIS_EXECUTE, KNOWN_COMMANDS, fallback)
    ).toEqual(ANALYSIS_EXECUTE);
  });

  it.each([
    [
      "unknown version",
      { ...ANALYSIS_EXECUTE, command: { id: "analysis.execute", version: 2 } },
    ],
    ["unknown effect", { ...ANALYSIS_EXECUTE, effect: "write" }],
    ["missing target", { ...ANALYSIS_EXECUTE, target: undefined }],
    [
      "invalid version",
      { ...ANALYSIS_EXECUTE, command: { id: "analysis.execute", version: 0 } },
    ],
  ])("falls back to tool.call for an %s authority", (_label, authority) => {
    expect(
      classifyCommandCapability(authority, KNOWN_COMMANDS, fallback)
    ).toEqual({ kind: "tool.call", ...fallback });
  });
});
