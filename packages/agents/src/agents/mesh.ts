import type { ModelMessage, ToolSet, UIMessage } from "ai";

import { tool } from "ai";
import { z } from "zod";
import { tagTools } from "../harness/types";
import type { SessionStore } from "../session/store";
import { lastTextValue } from "./last-text";
import type { AgentCompatibilityRegistry, AgentEntry } from "./registry";

export const HUMAN = Symbol.for("mesh.human");
export type Human = typeof HUMAN;

export type NodeId = string | Human;

export type NodeType = "human" | "agent" | "tool" | "system";

export interface NodeSpec {
  agent?: AgentEntry;
  role: string;
  spec: Record<string, unknown>;
  type: NodeType;
}

export interface Message {
  at: number;
  content: string;
  from: NodeId;
  to: NodeId;
}

export type SendEvent =
  | { type: "delta"; text: string }
  | { type: "message"; message: Message };

export class Node {
  readonly id: NodeId;
  readonly role: string;
  readonly type: NodeType;
  readonly spec: Record<string, unknown>;
  readonly agent?: AgentEntry;

  constructor(id: NodeId, { role, type, spec, agent }: NodeSpec) {
    this.id = id;
    this.role = role;
    this.type = type;
    this.spec = spec;
    this.agent = agent;
  }

  static human(role = "user", spec: Record<string, unknown> = {}): Node {
    return new Node(HUMAN, { role, spec, type: "human" });
  }
}

export class Edge {
  readonly id: string;
  readonly user: NodeId;
  readonly assistant: NodeId;
  readonly createdAt: number;
  readonly history: Message[] = [];

  constructor(user: NodeId, assistant: NodeId, createdAt: number = Date.now()) {
    this.user = user;
    this.assistant = assistant;
    this.createdAt = createdAt;
    this.id = `${keyOf(user)}::${keyOf(assistant)}`;
  }

  has(node: NodeId): boolean {
    const k = keyOf(node);
    return k === keyOf(this.user) || k === keyOf(this.assistant);
  }

  append(message: Message): void {
    this.history.push(message);
  }

  get lastAt(): number | undefined {
    return this.history.at(-1)?.at;
  }
}

export interface MeshAgentSpec {
  agent: AgentEntry;
  role: string;
  spec?: Record<string, unknown>;
}

export interface MeshOptions {
  registry?: AgentCompatibilityRegistry;
  store?: SessionStore;
}

export class Mesh {
  readonly registry?: AgentCompatibilityRegistry;
  private readonly nodes = new Map<string, Node>();
  private readonly edges = new Map<string, Edge>();
  private readonly store?: SessionStore;
  private readonly sessions = new Map<string, string>();

  constructor(opts: MeshOptions = {}) {
    this.registry = opts.registry;
    this.store = opts.store;
  }

  register(id: string, { role, agent, spec = {} }: MeshAgentSpec): Node {
    const node = new Node(id, { agent, role, spec, type: "agent" });
    this.nodes.set(keyOf(node.id), node);
    return node;
  }

  registerHuman(): Node {
    const node = Node.human();
    this.nodes.set(keyOf(node.id), node);
    return node;
  }

  registerNode(node: Node): Node {
    this.nodes.set(keyOf(node.id), node);
    return node;
  }

  get(id: NodeId): Node | undefined {
    return this.nodes.get(keyOf(id));
  }

  has(id: string): boolean {
    return this.nodes.get(keyOf(id)) !== undefined;
  }

  list(): Node[] {
    return [...this.nodes.values()].filter((n) => n.type === "agent");
  }

  listNodes(): Node[] {
    return [...this.nodes.values()];
  }

  edge(a: NodeId, b: NodeId): Edge {
    const key = pairKey(a, b);
    let edge = this.edges.get(key);
    if (!edge) {
      edge = new Edge(a, b);
      this.edges.set(key, edge);
    }
    return edge;
  }

  edgeById(id: string): Edge | undefined {
    return this.edges.get(id);
  }

  edgesOf(node: NodeId): Edge[] {
    const k = keyOf(node);
    return [...this.edges.values()].filter((e) => {
      const ek = pairKey(e.user, e.assistant);
      return ek.includes(k);
    });
  }

  async *send(
    from: NodeId,
    to: NodeId,
    content: string,
    at: number = Date.now()
  ): AsyncGenerator<SendEvent> {
    const edge = this.edge(from, to);
    const message: Message = { at, content, from, to };
    edge.append(message);
    await this.persist(edge, message);
    yield { message, type: "message" };

    const assistant = this.get(to);
    if (!assistant?.agent) {
      return;
    }

    const result = await assistant.agent.stream({
      messages: toModelMessages(edge),
    });

    let text = "";
    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        text += part.text;
        yield { text: part.text, type: "delta" };
      }
    }

    const replyAt = Date.now();
    const reply: Message = { at: replyAt, content: text, from: to, to: from };
    edge.append(reply);
    await this.persist(edge, reply);
    yield { message: reply, type: "message" };
  }

  tools(self: NodeId): ToolSet {
    // `message_agent.execute` must be a generator (so can't be an arrow), so
    // bind the one method it needs rather than aliasing `this` into the closure.
    const send = this.send.bind(this);
    return tagTools(
      {
        list_agents: tool({
          description: "List the other agents you can talk to.",
          execute: () =>
            this.list()
              .map((n) => String(n.id))
              .filter((name) => name !== self)
              .map((name) => {
                const node = this.get(name);
                return { id: name, role: node?.role ?? name };
              }),
          inputSchema: z.object({}),
        }),

        message_agent: tool({
          description:
            "Send a message to another agent and stream their reply. Conversations are ongoing — each call continues the thread with that agent.",
          async *execute({ agent, message }) {
            let reply = "(no reply)";
            let accumulated = "";
            for await (const event of send(self, agent, message)) {
              if (event.type === "delta") {
                accumulated += event.text;
                yield {
                  id: `msg-${Date.now().toString(36)}`,
                  parts: [{ text: accumulated, type: "text" as const }],
                  role: "assistant" as const,
                } satisfies UIMessage;
              }
              if (
                event.type === "message" &&
                String(event.message.from) === agent &&
                event.message.content
              ) {
                reply = event.message.content;
              }
            }
            // Yield the final message — the AI SDK takes a generator tool's output
            // from the *last yielded value*, not `return`. Without this yield, a
            // reply with no text-delta events (e.g. the sub-agent ends on a tool
            // result) yields nothing and `toModelOutput` gets an undefined output.
            const final = {
              id: `msg-${Date.now().toString(36)}`,
              parts: [{ text: reply, type: "text" as const }],
              role: "assistant" as const,
            } satisfies UIMessage;
            yield final;
            return final;
          },
          inputSchema: z.object({
            agent: z.string().describe("The id of the agent to message"),
            message: z.string().describe("What to say to them"),
          }),
          toModelOutput: ({
            output: msg,
          }: {
            output: UIMessage | undefined;
          }) => ({
            type: "text" as const,
            value: lastTextValue(msg, "(no reply)"),
          }),
        }),
      },
      "mesh"
    );
  }

  private async persist(edge: Edge, message: Message): Promise<void> {
    if (!this.store) {
      return;
    }
    let sessionId = this.sessions.get(edge.id);
    if (!sessionId) {
      const session = await this.store.createSession({ id: edge.id });
      sessionId = session.id;
      this.sessions.set(edge.id, sessionId);
    }
    const role =
      keyOf(message.from) === keyOf(edge.user) ? "user" : "assistant";
    await this.store.appendMessage({
      parts: [{ text: message.content, type: "text" }],
      role,
      sessionId,
    });
  }
}

export function createMesh(opts?: MeshOptions): Mesh {
  return new Mesh(opts);
}

export const keyOf = (id: NodeId): string =>
  typeof id === "symbol" ? "@human" : id;

const pairKey = (a: NodeId, b: NodeId): string => {
  const [x, y] = [keyOf(a), keyOf(b)].sort();
  return `${x}::${y}`;
};

const toModelMessages = (edge: Edge): ModelMessage[] =>
  edge.history.map((msg) => ({
    content: msg.content,
    role: keyOf(msg.from) === keyOf(edge.user) ? "user" : "assistant",
  }));
