import { describe, expect, it } from "vitest";
import { LoopAgent } from "../../agents/loop-agent";
import { SessionHarness } from "../../harness";
import type { SessionEvent } from "../../session";
import { InMemorySessionStore } from "../../session";
import {
  createScriptedMockModel,
  textStreamResult,
  toolCallStreamResult,
} from "../helpers/mock-language-model";

async function drain(
  stream: AsyncIterable<SessionEvent>
): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of stream) {
    out.push(event);
  }
  return out;
}

/**
 * Regression: once mesh tools went through the tool compiler, `message_agent`
 * (a generator tool) came back as `{}` in 1ms — the compiler's async wrapper
 * handed the SDK a Promise of the generator instead of the generator, so the
 * sub-agent never ran. The whole path must work end to end: primary calls the
 * tool, the sub-agent streams, interim results surface, the reply lands.
 */
describe("SessionHarness — message_agent through the compiler", () => {
  it("streams the sub-agent's reply as preliminary results and returns it", async () => {
    const primary = createScriptedMockModel({
      stream: [
        toolCallStreamResult("call-1", "message_agent", {
          agent: "planner",
          message: "plan it",
        }),
        textStreamResult("done"),
      ],
    });
    const harness = new SessionHarness(
      {
        instructions: "x",
        model: primary,
        nodeId: "root",
        sessionId: "s",
        store: new InMemorySessionStore(),
      },
      { sessionId: "s" }
    );
    harness.mesh.register("planner", {
      agent: new LoopAgent(
        {
          instructions: "plan",
          model: createScriptedMockModel({
            stream: [textStreamResult("step one\nstep two\n")],
          }),
        },
        { sessionId: "s-planner" }
      ),
      role: "planner",
    });

    const events = await drain(harness.stream("go"));

    const results = events.filter(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.toolCallId === "call-1"
    );
    const final = results.find((r) => !r.preliminary);
    expect(final).toBeDefined();
    expect(JSON.stringify(final?.output)).toContain("step one");
    expect(results.some((r) => r.preliminary)).toBe(true);

    const message = await harness.store?.listMessages("s");
    const assistant = message?.find((m) => m.role === "assistant");
    const stored = assistant?.parts.filter((p) => p.type === "tool_result");
    expect(stored).toHaveLength(1);
  });
});
