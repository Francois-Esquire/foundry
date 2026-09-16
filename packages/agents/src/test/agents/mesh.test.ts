import { describe, expect, it } from "vitest";

import type { Message, SendEvent } from "../../agents/mesh";
import { createMesh, Edge, HUMAN, Mesh, Node } from "../../agents/mesh";
import type { AgentEntry } from "../../agents/registry";
import { createAgentCompatibilityRegistry } from "../../agents/registry";
import { InMemorySessionStore } from "../../session/store";

function mockAgent(...deltas: string[]): AgentEntry {
  return {
    stream: () =>
      Promise.resolve({
        stream: (function* () {
          for (const text of deltas) {
            yield { text, type: "text-delta" };
          }
        })(),
      }),
  } as unknown as AgentEntry;
}

function agentNode(id: string, agent?: AgentEntry): Node {
  return new Node(id, { agent, role: id, spec: {}, type: "agent" });
}

async function drain(
  stream: AsyncIterable<SendEvent>
): Promise<{ events: SendEvent[]; messages: Message[]; deltas: string[] }> {
  const events: SendEvent[] = [];
  const messages: Message[] = [];
  const deltas: string[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "message") {
      messages.push(event.message);
    }
    if (event.type === "delta") {
      deltas.push(event.text);
    }
  }
  return { deltas, events, messages };
}

describe("Node", () => {
  it("constructs with id, role, type, spec", () => {
    const node = new Node("a", {
      role: "worker",
      spec: { x: 1 },
      type: "agent",
    });
    expect(node.id).toBe("a");
    expect(node.role).toBe("worker");
    expect(node.type).toBe("agent");
    expect(node.spec).toEqual({ x: 1 });
  });

  it("human() factory creates a HUMAN node", () => {
    const node = Node.human();
    expect(node.id).toBe(HUMAN);
    expect(node.type).toBe("human");
    expect(node.role).toBe("user");
  });

  it("agent is undefined until provided", () => {
    const node = agentNode("a");
    expect(node.agent).toBeUndefined();
  });

  it("agent is set when provided", () => {
    const agent = mockAgent("hi");
    const node = agentNode("a", agent);
    expect(node.agent).toBe(agent);
  });
});

describe("Edge", () => {
  it("stores user and assistant roles from constructor order", () => {
    const edge = new Edge("alice", "bob");
    expect(edge.user).toBe("alice");
    expect(edge.assistant).toBe("bob");
  });

  it("id is derived from user::assistant keys", () => {
    const edge = new Edge("alice", "bob");
    expect(edge.id).toBe("alice::bob");
  });

  it("has() returns true for either endpoint", () => {
    const edge = new Edge("alice", "bob");
    expect(edge.has("alice")).toBe(true);
    expect(edge.has("bob")).toBe(true);
    expect(edge.has("carol")).toBe(false);
  });

  it("append() adds to history and lastAt tracks the last message", () => {
    const edge = new Edge("alice", "bob");
    expect(edge.lastAt).toBeUndefined();

    const msg: Message = { at: 100, content: "hi", from: "alice", to: "bob" };
    edge.append(msg);
    expect(edge.history).toHaveLength(1);
    expect(edge.lastAt).toBe(100);
  });

  it("createdAt defaults to Date.now()", () => {
    const before = Date.now();
    const edge = new Edge("a", "b");
    const after = Date.now();
    expect(edge.createdAt).toBeGreaterThanOrEqual(before);
    expect(edge.createdAt).toBeLessThanOrEqual(after);
  });
});

describe("Mesh (node and edge management)", () => {
  it("registerNode stores node", () => {
    const mesh = new Mesh();
    const node = agentNode("a", mockAgent("ok"));
    mesh.registerNode(node);
    expect(mesh.get("a")).toBe(node);
  });

  it("registerNode without agent still stores the node", () => {
    const mesh = new Mesh();
    const node = agentNode("a");
    mesh.registerNode(node);
    expect(mesh.get("a")).toBe(node);
    expect(node.agent).toBeUndefined();
  });

  it("get returns undefined for unregistered nodes", () => {
    const mesh = new Mesh();
    expect(mesh.get("nope")).toBeUndefined();
  });

  it("listNodes returns all registered nodes", () => {
    const mesh = new Mesh();
    mesh.registerNode(agentNode("a"));
    mesh.registerNode(agentNode("b"));
    expect(mesh.listNodes().map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("edge() creates on first call, returns same on subsequent", () => {
    const mesh = new Mesh();
    const e1 = mesh.edge("a", "b");
    const e2 = mesh.edge("a", "b");
    const e3 = mesh.edge("b", "a");
    expect(e1).toBe(e2);
    expect(e1).toBe(e3);
  });

  it("edgeById looks up by the edge id", () => {
    const mesh = new Mesh();
    const edge = mesh.edge("alice", "bob");
    expect(mesh.edgeById(edge.id)).toBe(edge);
    expect(mesh.edgeById("nonexistent")).toBeUndefined();
  });

  it("edgesOf returns all edges a node participates in", () => {
    const mesh = new Mesh();
    mesh.edge("a", "b");
    mesh.edge("a", "c");
    mesh.edge("b", "c");
    const aEdges = mesh.edgesOf("a");
    expect(aEdges).toHaveLength(2);
    const bEdges = mesh.edgesOf("b");
    expect(bEdges).toHaveLength(2);
    const cEdges = mesh.edgesOf("c");
    expect(cEdges).toHaveLength(2);
  });

  it("edgesOf returns empty for a node with no edges", () => {
    const mesh = new Mesh();
    mesh.registerNode(agentNode("lonely"));
    expect(mesh.edgesOf("lonely")).toEqual([]);
  });

  it("send creates edge, appends message, and triggers assistant reply", async () => {
    const mesh = new Mesh();
    mesh.registerNode(agentNode("alice", mockAgent("hello back")));
    mesh.registerNode(agentNode("bob"));

    const { messages, deltas } = await drain(
      mesh.send("bob", "alice", "hello")
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.from).toBe("bob");
    expect(messages[0]?.to).toBe("alice");
    expect(messages[0]?.content).toBe("hello");
    expect(messages[1]?.from).toBe("alice");
    expect(messages[1]?.to).toBe("bob");
    expect(messages[1]?.content).toBe("hello back");
    expect(deltas).toEqual(["hello back"]);
  });

  it("send yields message event first, then deltas, then reply message", async () => {
    const mesh = new Mesh();
    mesh.registerNode(agentNode("alice", mockAgent("hello ", "world")));
    mesh.registerNode(agentNode("bob"));

    const { events } = await drain(mesh.send("bob", "alice", "hi"));
    expect(events[0]?.type).toBe("message");
    expect(events[1]?.type).toBe("delta");
    expect(events[2]?.type).toBe("delta");
    expect(events[3]?.type).toBe("message");
  });

  it("send returns only the original message when assistant has no agent", async () => {
    const mesh = new Mesh();
    mesh.registerNode(agentNode("alice"));
    mesh.registerNode(agentNode("bob"));

    const { messages, deltas } = await drain(
      mesh.send("bob", "alice", "hello")
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("hello");
    expect(deltas).toEqual([]);
  });

  it("send returns only the original message when assistant is not registered", async () => {
    const mesh = new Mesh();
    mesh.registerNode(agentNode("bob"));

    const { messages } = await drain(mesh.send("bob", "ghost", "hello"));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.from).toBe("bob");
    expect(messages[0]?.to).toBe("ghost");
  });

  it("send supports async agent streams", async () => {
    const mesh = new Mesh();
    mesh.registerNode(
      agentNode("alice", {
        stream: () =>
          Promise.resolve({
            stream: (async function* () {
              await new Promise((r) => setTimeout(r, 10));
              yield { text: "async reply", type: "text-delta" };
            })(),
          }),
      } as unknown as AgentEntry)
    );
    mesh.registerNode(agentNode("bob"));

    const { messages } = await drain(mesh.send("bob", "alice", "ping"));
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe("async reply");
  });

  it("send appends both messages to the edge history", async () => {
    const mesh = new Mesh();
    mesh.registerNode(agentNode("alice", mockAgent("reply")));
    mesh.registerNode(agentNode("bob"));

    await drain(mesh.send("bob", "alice", "first"));
    await drain(mesh.send("alice", "bob", "second"));

    const edge = mesh.edge("alice", "bob");
    expect(edge.history).toHaveLength(3);
  });

  it("first send establishes user/assistant direction on the edge", async () => {
    const mesh = new Mesh();
    mesh.registerNode(agentNode("alice", mockAgent("hi")));
    mesh.registerNode(agentNode("bob"));

    await drain(mesh.send("bob", "alice", "hello"));
    const edge = mesh.edge("bob", "alice");
    expect(edge.user).toBe("bob");
    expect(edge.assistant).toBe("alice");
  });

  it("works with HUMAN node", async () => {
    const mesh = new Mesh();
    mesh.registerNode(Node.human());
    mesh.registerNode(agentNode("assistant", mockAgent("sure")));

    const { messages } = await drain(
      mesh.send(HUMAN, "assistant", "do something")
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe("sure");
  });

  it("send persists messages to the store when present", async () => {
    const store = new InMemorySessionStore();
    const mesh = new Mesh({ store });
    mesh.registerNode(agentNode("alice", mockAgent("hello back")));
    mesh.registerNode(agentNode("bob"));

    await drain(mesh.send("bob", "alice", "hello"));

    const edge = mesh.edge("bob", "alice");
    const messages = await store.listMessages(edge.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.parts).toEqual([{ text: "hello", type: "text" }]);
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.parts).toEqual([{ text: "hello back", type: "text" }]);
  });

  it("send persists without agent (single message, user role)", async () => {
    const store = new InMemorySessionStore();
    const mesh = new Mesh({ store });
    mesh.registerNode(agentNode("alice"));
    mesh.registerNode(agentNode("bob"));

    await drain(mesh.send("bob", "alice", "hello"));

    const edge = mesh.edge("bob", "alice");
    const messages = await store.listMessages(edge.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
  });

  it("send reuses the same session per edge", async () => {
    const store = new InMemorySessionStore();
    const mesh = new Mesh({ store });
    mesh.registerNode(agentNode("alice", mockAgent("reply")));
    mesh.registerNode(agentNode("bob"));

    await drain(mesh.send("bob", "alice", "first"));
    await drain(mesh.send("bob", "alice", "second"));

    const edge = mesh.edge("bob", "alice");
    const messages = await store.listMessages(edge.id);
    expect(messages).toHaveLength(4);
  });

  it("send creates separate sessions per edge", async () => {
    const store = new InMemorySessionStore();
    const mesh = new Mesh({ store });
    mesh.registerNode(agentNode("alice", mockAgent("hi")));
    mesh.registerNode(agentNode("bob", mockAgent("hey")));
    mesh.registerNode(agentNode("carol", mockAgent("yo")));

    await drain(mesh.send("bob", "alice", "hi"));
    await drain(mesh.send("carol", "alice", "hi"));

    const ab = await store.listMessages(mesh.edge("alice", "bob").id);
    const ac = await store.listMessages(mesh.edge("alice", "carol").id);
    expect(ab).toHaveLength(2);
    expect(ac).toHaveLength(2);
  });

  it("works without a store (no persistence)", async () => {
    const mesh = new Mesh();
    mesh.registerNode(agentNode("alice", mockAgent("hello back")));
    mesh.registerNode(agentNode("bob"));

    const { messages } = await drain(mesh.send("bob", "alice", "hello"));
    expect(messages).toHaveLength(2);
  });
});

describe("Mesh (agent registration and tools)", () => {
  it("register adds an agent node with agent", () => {
    const mesh = new Mesh();
    const agent = mockAgent("ok");
    const node = mesh.register("alice", {
      agent,
      role: "researcher",
    });
    expect(node.id).toBe("alice");
    expect(node.role).toBe("researcher");
    expect(node.type).toBe("agent");
    expect(node.agent).toBe(agent);
    expect(mesh.get("alice")).toBe(node);
  });

  it("registerHuman adds a HUMAN node", () => {
    const mesh = new Mesh();
    const node = mesh.registerHuman();
    expect(node.id).toBe(HUMAN);
    expect(node.type).toBe("human");
  });

  it("has returns true for registered agents", () => {
    const mesh = new Mesh();
    mesh.register("alice", { agent: mockAgent(), role: "a" });
    expect(mesh.has("alice")).toBe(true);
    expect(mesh.has("bob")).toBe(false);
  });

  it("list returns only agent nodes, not human", () => {
    const mesh = new Mesh();
    mesh.register("alice", { agent: mockAgent(), role: "a" });
    mesh.register("bob", { agent: mockAgent(), role: "b" });
    mesh.registerHuman();
    expect(mesh.list().map((n) => n.id)).toEqual(["alice", "bob"]);
  });

  it("send delegates to mesh and triggers agent stream", async () => {
    const mesh = new Mesh();
    mesh.register("alice", { agent: mockAgent("hello back"), role: "a" });
    mesh.register("bob", { agent: mockAgent(), role: "b" });

    const { messages } = await drain(mesh.send("bob", "alice", "hello"));
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe("hello back");
  });

  it("send streams deltas from the agent", async () => {
    const mesh = new Mesh();
    mesh.register("alice", {
      agent: mockAgent("hello ", "world"),
      role: "a",
    });
    mesh.register("bob", { agent: mockAgent(), role: "b" });

    const { deltas } = await drain(mesh.send("bob", "alice", "hi"));
    expect(deltas).toEqual(["hello ", "world"]);
  });

  it("tools returns list_agents and message_agent", () => {
    const mesh = new Mesh();
    mesh.register("alice", { agent: mockAgent("hi"), role: "a" });
    mesh.register("bob", { agent: mockAgent(), role: "b" });

    const tools = mesh.tools("bob");
    expect(tools.list_agents).toBeDefined();
    expect(tools.message_agent).toBeDefined();
  });

  it("tools list_agents uses mesh nodes even when registry is present", async () => {
    const registry = createAgentCompatibilityRegistry();
    const stub = {
      stream: () => ({ text: Promise.resolve("") }),
    } as unknown as AgentEntry;
    registry.register("alice", stub);
    registry.register("bob", stub);
    registry.register("carol", stub);

    const mesh = new Mesh({ registry });
    mesh.register("alice", { agent: mockAgent("hi"), role: "researcher" });
    mesh.register("bob", { agent: mockAgent(), role: "worker" });

    const tools = mesh.tools("bob");
    expect(
      await tools.list_agents?.execute?.(
        {},
        { context: undefined, messages: [], toolCallId: "t" }
      )
    ).toEqual([{ id: "alice", role: "researcher" }]);
  });

  it("tools list_agents falls back to mesh nodes without registry", async () => {
    const mesh = new Mesh();
    mesh.register("alice", { agent: mockAgent("hi"), role: "researcher" });
    mesh.register("bob", { agent: mockAgent(), role: "worker" });

    const tools = mesh.tools("bob");
    expect(
      await tools.list_agents?.execute?.(
        {},
        { context: undefined, messages: [], toolCallId: "t" }
      )
    ).toEqual([{ id: "alice", role: "researcher" }]);
  });

  it("tools message_agent streams deltas and returns the reply", async () => {
    const mesh = new Mesh();
    mesh.register("alice", { agent: mockAgent("4", "2"), role: "a" });
    mesh.register("bob", { agent: mockAgent(), role: "b" });

    const tools = mesh.tools("bob");
    const gen = tools.message_agent?.execute?.(
      { agent: "alice", message: "what is the answer" },
      { context: undefined, messages: [], toolCallId: "t" }
    ) as AsyncGenerator<unknown, unknown, undefined> | undefined;
    if (!gen) {
      throw new Error("expected a message_agent generator");
    }

    const yielded: { parts: { text: string }[] }[] = [];
    let result = await gen.next();
    while (!result.done) {
      yielded.push(result.value as { parts: { text: string }[] });
      result = await gen.next();
    }

    // Deltas stream as accumulating previews; the final reply is YIELDED last.
    // The AI SDK takes a generator tool's output from the last yielded value
    // (not `return`), so the final message must be yielded, not just returned.
    expect(yielded[0]?.parts[0]?.text).toBe("4");
    expect(yielded[1]?.parts[0]?.text).toBe("42");
    expect(yielded.at(-1)?.parts[0]?.text).toBe("42");
  });

  it("tools message_agent yields a final message even with no deltas", async () => {
    // Regression: the assistant node has no agent, so `send` streams no
    // text-delta events. The tool must still YIELD a final UIMessage — otherwise
    // the SDK's "output = last yielded value" is undefined and `toModelOutput`
    // crashes on `msg.parts`.
    const mesh = new Mesh();
    mesh.registerNode(agentNode("alice"));
    mesh.register("bob", { agent: mockAgent(), role: "b" });

    const tools = mesh.tools("bob");
    const gen = tools.message_agent?.execute?.(
      { agent: "alice", message: "hello" },
      { context: undefined, messages: [], toolCallId: "t" }
    ) as
      | AsyncGenerator<{ parts: { text: string }[] }, unknown, undefined>
      | undefined;
    if (!gen) {
      throw new Error("expected a message_agent generator");
    }

    const yielded: { parts: { text: string }[] }[] = [];
    let result = await gen.next();
    while (!result.done) {
      yielded.push(result.value);
      result = await gen.next();
    }

    expect(yielded).toHaveLength(1);
    expect(yielded.at(-1)?.parts[0]?.text).toBe("(no reply)");
  });

  it("tools message_agent.toModelOutput tolerates an undefined output", () => {
    const mesh = new Mesh();
    mesh.register("alice", { agent: mockAgent("hi"), role: "a" });
    mesh.register("bob", { agent: mockAgent(), role: "b" });

    const out = mesh.tools("bob").message_agent?.toModelOutput?.({
      input: { message: "hi" },
      output: undefined,
      toolCallId: "c1",
    });
    expect(out).toEqual({ type: "text", value: "(no reply)" });
  });

  it("edge and edgesOf delegate to mesh", async () => {
    const mesh = new Mesh();
    mesh.register("alice", { agent: mockAgent("hi"), role: "a" });
    mesh.register("bob", { agent: mockAgent("hey"), role: "b" });
    mesh.register("carol", { agent: mockAgent(), role: "c" });

    await drain(mesh.send("alice", "bob", "hi"));
    await drain(mesh.send("alice", "carol", "hi"));

    expect(mesh.edgesOf("alice")).toHaveLength(2);
    expect(mesh.edge("alice", "bob").history).toHaveLength(2);
  });

  it("createMesh() returns a Mesh instance", () => {
    expect(createMesh()).toBeInstanceOf(Mesh);
  });

  it("createMesh({ store }) wires the store into mesh", async () => {
    const store = new InMemorySessionStore();
    const mesh = createMesh({ store });
    mesh.register("alice", { agent: mockAgent("hi"), role: "a" });
    mesh.register("bob", { agent: mockAgent(), role: "b" });

    await drain(mesh.send("bob", "alice", "hello"));

    const edge = mesh.edge("alice", "bob");
    const messages = await store.listMessages(edge.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");
  });
});
