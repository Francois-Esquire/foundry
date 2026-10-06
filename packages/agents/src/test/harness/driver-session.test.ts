import { describe, expect, it, vi } from "vitest";

import { createInMemoryAgentAuthorizer } from "../../authorization/authorization";
import { createDriverSession } from "../../harness/driver-session";
import type {
  DriverSessionSettings,
  HarnessTurnDriver,
} from "../../harness/turn-driver";
import type { SessionEvent } from "../../session/events";
import { InMemorySessionStore } from "../../session/store";
import { textDelta } from "../helpers/stream-parts";

function settings(
  store = new InMemorySessionStore(),
  sessionId = "host-session"
): DriverSessionSettings {
  return {
    agentId: "coder",
    model: { harness: "native", id: "model" },
    policy: createInMemoryAgentAuthorizer().authorizer,
    profile: {
      allowedTools: [],
      disallowedTools: [],
      maxSteps: 30,
      mode: "scheduled",
      unresolved: "deny",
    },
    sessionId,
    store,
  };
}

function driver(): HarnessTurnDriver {
  return {
    capabilities: { interruption: true, steering: false },
    id: "native",
    run: vi.fn(async (options) => {
      await options.onSessionId(
        options.nativeSessionId ?? `native-${options.sessionId}`
      );
      await options.onToolEvent({
        agentId: "untrusted",
        harness: "wrong",
        inputSummary: "token=secret",
        outcome: "refused",
        reason: "policy denial",
        sessionId: "wrong",
        toolCallId: "c1",
        toolName: "Bash",
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield textDelta("done");
        },
      };
    }),
  };
}

describe("native driver session", () => {
  it("reopens a native session, sends only new input, persists tool events with identity", async () => {
    const config = settings();
    const first = driver();
    const session = createDriverSession(config, first);
    const events: SessionEvent[] = [];
    for await (const event of session.stream("first")) {
      events.push(event);
    }
    expect(events.some((event) => event.type === "harness-tool")).toBe(true);
    expect(
      (await config.store.listMessages("host-session")).flatMap(
        (message) => message.parts
      )
    ).toContainEqual({
      event: {
        agentId: "coder",
        harness: "native",
        inputSummary: "token=[redacted]",
        outcome: "refused",
        reason: "policy denial",
        sessionId: "host-session",
        toolCallId: "c1",
        toolName: "Bash",
      },
      type: "harness_tool",
    });
    const second = driver();
    const reopened = createDriverSession(config, second);
    expect((await reopened.generate("second")).sessionId).toBe("host-session");
    expect(second.run).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "second",
        nativeSessionId: "native-host-session",
        sessionId: "host-session",
      })
    );
    expect(second.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ messages: expect.anything() })
    );
    await expect(reopened.steer("new instruction")).rejects.toThrow(
      "does not support steering"
    );
  });

  it("keeps concurrent sessions and their native IDs isolated", async () => {
    const store = new InMemorySessionStore();
    const a = createDriverSession(settings(store, "a"), driver());
    const b = createDriverSession(settings(store, "b"), driver());
    const results = await Promise.all([
      a.generate("alpha"),
      b.generate("beta"),
    ]);
    expect(results.map((message) => message.sessionId)).toEqual(["a", "b"]);
    const aHistory = JSON.stringify(await store.listMessages("a"));
    const bHistory = JSON.stringify(await store.listMessages("b"));
    expect(aHistory).toContain("native-a");
    expect(aHistory).not.toContain("native-b");
    expect(bHistory).toContain("native-b");
    expect(bHistory).not.toContain("alpha");
  });

  it("close waits for the interrupted terminal message to persist", async () => {
    const config = settings();
    config.profile = { ...config.profile, mode: "attended", unresolved: "ask" };
    config.approve = vi.fn(() => new Promise<never>(() => undefined));
    const original = config.store.appendMessage.bind(config.store);
    let release!: () => void;
    const persist = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = vi
      .spyOn(config.store, "appendMessage")
      .mockImplementation(async (input) => {
        if (input.role === "assistant") {
          await persist;
        }
        return original(input);
      });
    const native = driver();
    native.run = async (options) => {
      await options.permission({
        input: {},
        sessionId: options.sessionId,
        signal: options.signal,
        toolCallId: "pending",
        toolName: "Bash",
      });
      throw new Error("unexpected permission result");
    };
    const session = createDriverSession(config, native);
    const turn = session.generate("wait");
    await vi.waitFor(() => expect(config.approve).toHaveBeenCalled());
    let closed = false;
    const closing = session.close?.().then(() => {
      closed = true;
    });
    await vi.waitFor(() =>
      expect(append).toHaveBeenCalledWith(
        expect.objectContaining({ role: "assistant", status: "error" })
      )
    );
    expect(closed).toBe(false);
    release();
    await closing;
    expect((await turn).sessionId).toBe("host-session");
    expect(closed).toBe(true);
    expect(() => session.stream("after close")).toThrow("closed");
  });

  it("records native error chunks as an error terminal message", async () => {
    const native = driver();
    native.run = async () => ({
      async *[Symbol.asyncIterator]() {
        yield { error: new Error("native failed"), type: "error" };
      },
    });
    const reply = await createDriverSession(settings(), native).generate("run");
    expect(reply.status).toBe("error");
    expect(reply.parts).toContainEqual({
      message: "native failed",
      type: "error",
    });
  });

  it("rejects overlapping turns and interrupts an attended callback", async () => {
    const config = settings();
    config.profile = { ...config.profile, mode: "attended", unresolved: "ask" };
    config.approve = vi.fn(() => new Promise<never>(() => undefined));
    const native = driver();
    native.run = async (options) => {
      await options.permission({
        input: {},
        sessionId: options.sessionId,
        signal: options.signal,
        toolCallId: "pending",
        toolName: "Bash",
      });
      throw new Error("unexpected permission result");
    };
    const session = createDriverSession(config, native);
    const pending = session.generate("wait");
    expect(() => session.stream("overlap")).toThrow("one turn");
    await vi.waitFor(() => expect(config.approve).toHaveBeenCalled());
    await session.interrupt();
    expect((await pending).status).toBe("error");
    expect((await pending).parts).toContainEqual({
      message: "Harness turn interrupted.",
      type: "error",
    });
  });
});
