/**
 * `agent.extend`: the same agent on another route or with other settings.
 * It keeps the id, so approvals and triggers filed under it carry over, and
 * the route is no part of an id, so nothing about a route can conflict.
 */

import { Output } from "ai";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { catalog } from "~/authoring/catalog";
import { agent, skills } from "~/authoring/resources";
import { dispose, setHost } from "~/authoring/runtime";
import type { Agent } from "~/lib/types";
import { testEngine } from "../helpers/engine";

const engines: { dispose(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await dispose();
  catalog.reset();
});

const DIFFERENT_PROMPT = /different prompt/;

const verdict = Output.object({
  schema: z.object({ approved: z.boolean() }),
});
const summary = Output.object({ schema: z.object({ text: z.string() }) });

describe("extend", () => {
  it("keeps the id, prompt and skills, and changes the route", () => {
    const loaded = skills.load();
    const reviewer = agent({
      name: "reviewer",
      prompt: "Review.",
      provider: "claude-code",
      skills: loaded,
    });
    const onCodex = reviewer.extend({ provider: "codex" });
    expect(onCodex.id).toBe("reviewer");
    expect(onCodex.prompt).toBe("Review.");
    expect(onCodex.skills).toBe(loaded);
    expect(onCodex.provider).toBe("codex");
    expect(reviewer.provider).toBe("claude-code");
  });

  it("keeps a nameless agent's digest id", () => {
    const reviewer = agent({ prompt: "Review the diff." });
    expect(reviewer.extend({ model: "gpt-5.5", provider: "codex" }).id).toBe(
      reviewer.id
    );
  });

  it("keeps what it does not set, and overrides what it does", () => {
    const reviewer = agent({
      model: "claude-opus-4.7",
      name: "reviewer",
      prompt: "Review.",
      provider: "claude-code",
    });
    expect(reviewer.extend({ model: "claude-sonnet-4.6" })).toMatchObject({
      model: "claude-sonnet-4.6",
      provider: "claude-code",
    });
    expect(reviewer.extend({ provider: "codex" })).toMatchObject({
      model: "claude-opus-4.7",
      provider: "codex",
    });
  });

  it("merges settings into the base's, the extension's on top", () => {
    const reviewer = agent({
      name: "reviewer",
      prompt: "Review.",
      settings: {
        maxOutputTokens: 1000,
        providerOptions: {
          anthropic: { effort: "high", thinking: { type: "enabled" } },
          openai: { reasoningEffort: "low" },
        },
        temperature: 0.2,
      },
    });
    const extended = reviewer.extend({
      settings: {
        providerOptions: { anthropic: { effort: "low" } },
        temperature: 0.7,
      },
    });
    expect(extended.settings).toEqual({
      maxOutputTokens: 1000,
      providerOptions: {
        anthropic: { effort: "low", thinking: { type: "enabled" } },
        openai: { reasoningEffort: "low" },
      },
      temperature: 0.7,
    });
    // The base is unchanged.
    expect(reviewer.settings?.temperature).toBe(0.2);
    expect(reviewer.settings?.providerOptions?.anthropic?.effort).toBe("high");
  });

  it("replaces an array and an output rather than merging them", () => {
    const reviewer = agent({
      name: "reviewer",
      prompt: "Review.",
      settings: { output: verdict, stopSequences: ["END", "STOP"] },
    });
    const extended = reviewer.extend({
      settings: { output: summary, stopSequences: ["DONE"] },
    });
    expect(extended.settings?.stopSequences).toEqual(["DONE"]);
    expect(extended.settings?.output).toBe(summary);
    expect(reviewer.extend({ provider: "codex" }).settings?.output).toBe(
      verdict
    );
  });

  it("extends an extension, keeping the id and merging each in turn", () => {
    const reviewer = agent({
      name: "reviewer",
      prompt: "Review.",
      settings: { maxOutputTokens: 1000, temperature: 0.2 },
    });
    const twice = reviewer
      .extend({ provider: "codex", settings: { temperature: 0.5 } })
      .extend({ model: "gpt-5.5", settings: { topP: 0.9 } });
    expect(twice).toMatchObject({
      id: "reviewer",
      model: "gpt-5.5",
      prompt: "Review.",
      provider: "codex",
      settings: { maxOutputTokens: 1000, temperature: 0.5, topP: 0.9 },
    });
  });

  it("types its output after the output it sets, else the base's", () => {
    const reviewer = agent({
      name: "reviewer",
      prompt: "Review.",
      settings: { output: verdict },
    });
    expectTypeOf(reviewer.extend({ provider: "codex" })).toEqualTypeOf<
      Agent<typeof verdict>
    >();
    expectTypeOf(
      reviewer.extend({ settings: { output: summary } })
    ).toEqualTypeOf<Agent<typeof summary>>();
  });

  it("spreads to a plain definition", () => {
    const extended = agent({ name: "reviewer", prompt: "Review." }).extend({
      provider: "codex",
    });
    expect(Object.keys({ ...extended })).not.toContain("extend");
    expect(Object.keys({ ...extended })).not.toContain("generate");
    expect(typeof extended.extend).toBe("function");
  });

  it("generates on its own route", async () => {
    const engine = testEngine({
      print: () => undefined,
      reply: ({ executor }) => executor.provider ?? "default",
    });
    engines.push(engine);
    setHost(engine);
    const reviewer = agent({
      name: "reviewer",
      prompt: "Review.",
      provider: "claude-code",
    });
    expect((await reviewer.generate("Go.")).text).toBe("claude-code");
    expect(
      (await reviewer.extend({ provider: "codex" }).generate("Go.")).text
    ).toBe("codex");
  });
});

describe("an agent's id and the catalog", () => {
  it("is not moved by the route", () => {
    const make = (provider?: string) =>
      agent({ prompt: "Review the diff.", provider });
    const ids = [make(), make("codex"), make("claude-code")].map(
      ({ id }) => id
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("does not conflict for two declarations differing only in route", () => {
    agent({ name: "reviewer", prompt: "Review.", provider: "claude-code" });
    expect(() =>
      agent({ name: "reviewer", prompt: "Review.", provider: "codex" })
    ).not.toThrow();
  });

  it("still conflicts for a different prompt", () => {
    agent({ name: "reviewer", prompt: "Review." });
    expect(() => agent({ name: "reviewer", prompt: "Rewrite." })).toThrow(
      DIFFERENT_PROMPT
    );
  });

  it("keeps the declared agent, not its extensions", () => {
    const reviewer = agent({ name: "reviewer", prompt: "Review." });
    reviewer.extend({ provider: "codex" });
    expect(() =>
      reviewer.extend({ provider: "codex" }).extend({ model: "gpt-5.5" })
    ).not.toThrow();
    expect(catalog.agents.get("reviewer")).toBe(reviewer);
    expect(catalog.agents.size).toBe(1);
  });
});
