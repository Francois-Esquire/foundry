import { Output, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { SessionHarness } from "../../harness/session-harness";
import { InMemorySessionStore } from "../../store/memory";
import { fakeAuthorizer } from "../helpers/authorizer";
import {
  createScriptedMockModel,
  textStreamResult,
  toolCallStreamResult,
} from "../helpers/mock-language-model";

/** A harness whose one tool, `probe`, returns `output`. */
function harnessWithTool(output: unknown) {
  const store = new InMemorySessionStore();
  const harness = new SessionHarness(
    {
      instructions: "x",
      model: createScriptedMockModel({
        stream: [
          toolCallStreamResult("call-1", "probe", {}),
          textStreamResult("done"),
        ],
      }),
      policy: fakeAuthorizer(() => ({
        kind: "allow",
        source: "global-policy",
      })),
      store,
      tools: {
        probe: tool({
          execute: () => output,
          inputSchema: z.object({}),
        }),
      },
    },
    { sessionId: "s" }
  );
  return { harness, store };
}

function toolResults(messages: { parts: { type: string }[] }[]) {
  return messages.flatMap((m) =>
    m.parts.filter((part) => part.type === "tool_result")
  );
}

describe("what a session keeps of a turn's values", () => {
  it("keeps a tool's output in its JSON form, which any store can copy", async () => {
    const { harness, store } = harnessWithTool({
      at: new Date(0),
      cleanup: () => undefined,
      link: new URL("https://example.com/a"),
    });

    const reply = await harness.generate("go");

    expect(reply.status).toBe("complete");
    expect(toolResults(await store.listMessages("s"))).toEqual([
      {
        output: {
          at: "1970-01-01T00:00:00.000Z",
          link: "https://example.com/a",
        },
        toolCallId: "call-1",
        type: "tool_result",
      },
    ]);
  });

  it("fails the turn loudly, keeping an error result that names the tool, when its output has no JSON form", async () => {
    const { harness, store } = harnessWithTool({ count: 1n });
    const onError = vi.fn();

    const reply = await harness.generate("go", { onError });

    const why = expect.stringContaining(
      'Tool "probe" (call call-1) returned a value with no JSON form'
    );
    expect(reply.status).toBe("error");
    expect(reply.parts).toContainEqual({ message: why, type: "error" });
    // The SDK, which sends the output to the model as JSON, reports it too.
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: why })
    );
    const history = await store.listMessages("s");
    expect(history.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "error"],
    ]);
    expect(toolResults(history)).toEqual([
      { isError: true, output: why, toolCallId: "call-1", type: "tool_result" },
    ]);
  });

  it("keeps a structured output in its JSON form", async () => {
    const store = new InMemorySessionStore();
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: createScriptedMockModel({
          stream: [textStreamResult('{"site":"https://example.com/"}')],
        }),
        store,
      },
      { sessionId: "s" }
    );
    const output = Output.object({
      schema: z.object({ site: z.string().transform((s) => new URL(s)) }),
    });

    const turn = harness.stream("which site?", { output });

    await expect(turn.output).resolves.toEqual({
      site: new URL("https://example.com/"),
    });
    const [, reply] = await store.listMessages("s");
    expect(reply?.metadata?.output).toEqual({ site: "https://example.com/" });
  });

  it("rejects a structured output with no JSON form and keeps the reply", async () => {
    const store = new InMemorySessionStore();
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: createScriptedMockModel({
          stream: [textStreamResult('{"count":"7"}')],
        }),
        store,
      },
      { sessionId: "s" }
    );
    const output = Output.object({
      schema: z.object({ count: z.string().transform((s) => BigInt(s)) }),
    });

    const turn = harness.stream("how many?", { output });

    await expect(turn.output).rejects.toThrow(
      "The turn's structured output has no JSON form"
    );
    const reply = await turn.message;
    expect(reply.status).toBe("complete");
    expect(reply.metadata?.output).toBeUndefined();
    await expect(store.listMessages("s")).resolves.toHaveLength(2);
  });
});
