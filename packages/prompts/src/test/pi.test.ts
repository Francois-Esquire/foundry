import { describe, expect, it } from "vitest";

import { pi, prompts } from "..";

describe("pi dialect", () => {
  it("loads a skill with /skill: and keeps its arguments", () => {
    const prompt = prompts.pi("/skill:pdf-tools extract");
    expect(prompt.references).toEqual([
      expect.objectContaining({
        arguments: "extract",
        kind: "skill",
        name: "pdf-tools",
      }),
    ]);
    expect(prompt.tokens[0]?.text).toBe("/skill:pdf-tools");
  });

  it("expands /name as a prompt template unless it is a built-in command", () => {
    expect(
      prompts.pi('/component Button "click handler"').references[0]
    ).toMatchObject({
      arguments: 'Button "click handler"',
      kind: "template",
      name: "component",
    });
    expect(prompts.pi("/model").references[0]).toMatchObject({
      kind: "command",
      name: "model",
    });
  });

  it("only recognizes invocations that open the message", () => {
    expect(prompts.pi("please /skill:foo and /review").references).toEqual([]);
  });

  it("reads positional and rest placeholders", () => {
    expect(prompts.pi("Create $1 with features: $@").references).toEqual([
      expect.objectContaining({ selector: { by: "position", index: 1 } }),
      expect.objectContaining({ selector: { by: "all" } }),
    ]);
  });

  it("writes an all-arguments reference as $@", () => {
    expect(pi.write({ kind: "argument", selector: { by: "all" } })).toBe("$@");
  });

  it("mentions files and runs leading ! in the shell", () => {
    expect(prompts.pi("@README.md summarize").references[0]).toMatchObject({
      kind: "file",
      path: "README.md",
    });
    expect(prompts.pi("!npm run lint").references[0]).toMatchObject({
      command: "npm run lint",
      kind: "shell",
    });
  });
});
