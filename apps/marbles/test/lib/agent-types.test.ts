import { Output } from "ai";
import { expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { agent } from "~/authoring/resources";
import type {
  Agent,
  AgentDefinition,
  Agents,
  DeferredAgent,
  Session,
} from "~/lib/definitions/types";

const verdict = Output.object({ schema: z.object({ approved: z.boolean() }) });

it("keeps an object agent, and its extensions, a complete definition", () => {
  const reviewer = agent({ prompt: "Review.", settings: { output: verdict } });
  const definition: AgentDefinition<typeof verdict> = reviewer;
  const extended: AgentDefinition<typeof verdict> = reviewer
    .extend({ provider: "codex" })
    .extend({ model: "gpt-5.5" });
  const plain: AgentDefinition = agent({ prompt: "Plan." }).extend({
    provider: "codex",
  });
  const prompt: string = reviewer.prompt;
  const extendedPrompt: string = reviewer.extend({ provider: "codex" }).prompt;
  expectTypeOf(reviewer).toEqualTypeOf<Agent<typeof verdict>>();
  expectTypeOf(reviewer).toExtend<AgentDefinition<typeof verdict>>();
  expect([definition.id, extended.id, prompt, extendedPrompt]).toEqual([
    reviewer.id,
    reviewer.id,
    "Review.",
    "Review.",
  ]);
  expect(plain.prompt).toBe("Plan.");
});

it("types a function agent as deferred, sync or async, through extend", () => {
  const sync = agent(() => ({
    prompt: "Judge.",
    settings: { output: verdict },
  }));
  const later = agent(async () => {
    await Promise.resolve();
    return { prompt: "Judge.", settings: { output: verdict } };
  });
  const plain = agent(async () => ({ prompt: "Judge." }));
  expectTypeOf(sync).toEqualTypeOf<DeferredAgent<typeof verdict>>();
  expectTypeOf(later).toEqualTypeOf<DeferredAgent<typeof verdict>>();
  expectTypeOf(plain).toEqualTypeOf<DeferredAgent<never>>();
  expectTypeOf(plain).not.toEqualTypeOf<DeferredAgent<typeof verdict>>();
  expectTypeOf(
    later.extend({ provider: "codex" }).extend({ model: "gpt-5.5" })
  ).toEqualTypeOf<DeferredAgent<typeof verdict>>();
  // @ts-expect-error A function agent is not a complete definition.
  const definition: AgentDefinition = later;
  expect(definition.id).toBe(later.id);
  expect(later.prompt).toBeUndefined();
});

it("infers session output for either kind without opening sessions", () => {
  const checkSessionTypes = (open: Agents["session"]) => {
    const deferred = agent(async () => ({
      prompt: "Judge.",
      settings: { output: verdict },
    }));
    const object = agent({ prompt: "Judge.", settings: { output: verdict } });
    expectTypeOf(open(deferred)).resolves.toEqualTypeOf<
      Session<typeof verdict>
    >();
    expectTypeOf(open(object)).resolves.toEqualTypeOf<
      Session<typeof verdict>
    >();
    expectTypeOf(
      open(agent(async () => ({ prompt: "Plan." })))
    ).resolves.toEqualTypeOf<Session<never>>();
  };
  expectTypeOf(checkSessionTypes).toBeFunction();
});
