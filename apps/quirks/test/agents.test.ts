import { InMemorySessionStore } from "@foundry/agents/session";
import { agent, step } from "@foundry/quirks";
import { afterEach, describe, expect, it } from "vitest";

import { bindAgents } from "~/agents";
import { CLAUDE_CODE } from "~/harnesses";
import { registry } from "~/lib/registry";
import { mockModels } from "~/models/echo";

afterEach(() => {
  registry.reset();
});

describe("agent sessions", () => {
  it("keep their messages in the store across turns, by session id", async () => {
    const executors = [CLAUDE_CODE];
    const sessions = new InMemorySessionStore();
    const seen: string[] = [];
    registry.bind({
      agents: bindAgents({
        executors,
        models: mockModels(executors, ({ prompt }) => {
          seen.push(prompt);
          return "noted";
        }),
        sessions,
        skills: () => Promise.resolve([]),
      }),
      executors,
      log: () => undefined,
      sessions,
    } as never);

    const reviewer = agent("reviewer", { prompt: "You review code." });
    const ask = step("ask", async ({ agents }, input: string) => {
      const session = await agents.session(reviewer, { sessionId: "s-1" });
      const reply = await session.generate(input);
      return reply.parts.flatMap((part) =>
        part.type === "text" ? [part.text] : []
      );
    });

    await expect(ask.create().run("first")).resolves.toEqual(["noted"]);
    await expect(ask.create().run("second")).resolves.toEqual(["noted"]);

    const messages = await sessions.listMessages("s-1");
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // The second turn carried the first turn's history to the model.
    expect(seen[1]).toContain("first");
    expect(seen[1]).toContain("second");
  });
});
