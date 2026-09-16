import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { SessionHarness } from "../../harness";
import { InMemorySessionStore } from "../../session";
import { createSkillRegistry } from "../../skills";
import { textStreamResult } from "../helpers/mock-language-model";

/** A model that records the prompt the harness hands the provider. */
function capturingModel() {
  const captured: { prompt?: unknown } = {};
  const model = new MockLanguageModelV4({
    doStream: (options) => {
      captured.prompt = options.prompt;
      return Promise.resolve(textStreamResult("ok"));
    },
  });
  return { captured, model };
}

function systemMessage(prompt: unknown): string | undefined {
  const message = (prompt as { role: string; content: unknown }[]).find(
    (entry) => entry.role === "system"
  );
  return typeof message?.content === "string" ? message.content : undefined;
}

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _event of stream) {
    // exhaust
  }
}

describe("AgentHarness — instructions", () => {
  it("keeps base instructions when no skills are registered", async () => {
    const { model, captured } = capturingModel();
    const harness = new SessionHarness(
      {
        instructions: "You are the Document agent.",
        model,
        store: new InMemorySessionStore(),
        tools: {},
      },
      { sessionId: "s" }
    );

    await drain(harness.stream("hi"));

    expect(systemMessage(captured.prompt)).toContain(
      "You are the Document agent."
    );
  });

  it("appends the skill catalog to base instructions when skills exist", async () => {
    const { model, captured } = capturingModel();
    const skills = createSkillRegistry([
      {
        description: "House prose style.",
        instructions: "Write plainly.",
        name: "style-guide",
      },
    ]);
    const harness = new SessionHarness(
      {
        instructions: `You are the Document agent.\n\n${skills.instructions}`,
        model,
        store: new InMemorySessionStore(),
        tools: skills.tools,
      },
      { sessionId: "s" }
    );

    await drain(harness.stream("hi"));

    const system = systemMessage(captured.prompt);
    expect(system).toContain("You are the Document agent.");
    expect(system).toContain("style-guide");
  });
});
