import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { SessionHarness } from "../../harness";
import type { SessionEvent } from "../../session";
import { InMemorySessionStore } from "../../session";
import { routed, textStreamResult } from "../helpers/mock-language-model";

/** A model that records the call options the harness hands the provider. */
function capturingModel() {
  const captured: { providerOptions?: unknown; prompt?: unknown } = {};
  const model = new MockLanguageModelV4({
    doStream: (options) => {
      captured.providerOptions = options.providerOptions;
      captured.prompt = options.prompt;
      return Promise.resolve(textStreamResult("ok"));
    },
  });
  return { captured, model };
}

interface PromptMessage {
  providerOptions?: Record<string, Record<string, unknown>>;
}

function lastMessage(prompt: unknown): PromptMessage | undefined {
  return (prompt as PromptMessage[]).at(-1);
}

async function drain(stream: AsyncIterable<SessionEvent>) {
  const out: SessionEvent[] = [];
  for await (const event of stream) {
    out.push(event);
  }
  return out;
}

describe("SessionHarness — provider caching", () => {
  it("marks an Anthropic ephemeral breakpoint on the last message", async () => {
    const { model, captured } = capturingModel();
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: routed(model, { id: "m", provider: "anthropic" }),
        store: new InMemorySessionStore(),
        tools: {},
      },
      { sessionId: "s" }
    );

    await drain(harness.stream("hi"));

    expect(lastMessage(captured.prompt)?.providerOptions?.anthropic).toEqual({
      cacheControl: { type: "ephemeral" },
    });
    // Anthropic caches via the breakpoint only — no request-level option.
    expect(captured.providerOptions).toBeUndefined();
  });

  it("sets an OpenAI promptCacheKey at request level from the session id", async () => {
    const { model, captured } = capturingModel();
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: routed(model, { id: "m", provider: "openai" }),
        sessionId: "sess-1",
        store: new InMemorySessionStore(),
        tools: {},
      },
      { sessionId: "sess-1" }
    );

    await drain(harness.stream("hi"));

    expect(captured.providerOptions).toMatchObject({
      openai: { promptCacheKey: "sess-1" },
    });
    // No per-message breakpoint for OpenAI.
    expect(
      lastMessage(captured.prompt)?.providerOptions?.anthropic
    ).toBeUndefined();
  });

  it("merges the cache key over construction-time providerOptions", async () => {
    const { model, captured } = capturingModel();
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: routed(model, { id: "m", provider: "openai" }),
        providerOptions: { openai: { reasoningSummary: "auto" } },
        sessionId: "k",
        store: new InMemorySessionStore(),
        tools: {},
      },
      { sessionId: "k" }
    );

    await drain(harness.stream("hi"));

    // The promptCacheKey is added without dropping the reasoning knob.
    expect(captured.providerOptions).toMatchObject({
      openai: { promptCacheKey: "k", reasoningSummary: "auto" },
    });
  });

  it("emits no cache directives for an unknown (gateway) provider", async () => {
    const { model, captured } = capturingModel();
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: routed(model, { id: "m", provider: "gateway" }),
        store: new InMemorySessionStore(),
        tools: {},
      },
      { sessionId: "s" }
    );

    await drain(harness.stream("hi"));

    expect(captured.providerOptions).toBeUndefined();
    expect(
      lastMessage(captured.prompt)?.providerOptions?.anthropic
    ).toBeUndefined();
  });

  it("resolves the family from the model id under gateway routing", async () => {
    const { model, captured } = capturingModel();
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: routed(model, {
          id: "anthropic/claude-opus-4-8",
          provider: "gateway",
        }),
        store: new InMemorySessionStore(),
        tools: {},
      },
      { sessionId: "s" }
    );

    await drain(harness.stream("hi"));

    expect(lastMessage(captured.prompt)?.providerOptions?.anthropic).toEqual({
      cacheControl: { type: "ephemeral" },
    });
  });
});
