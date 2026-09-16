// Minimal stdio MCP server used to exercise the real client, transport, and
// tool bridge end to end. Newline-delimited JSON-RPC on stdin/stdout. Run
// directly by node (type stripping), never imported.
//
// Tools: `echo` (returns its input), `grow` (adds `shout` and announces the
// change), `ask` (elicits from the client and returns the answer), `log`
// (emits a log notification). One resource, one prompt.
import { createInterface } from "node:readline";

interface Message {
  error?: { message: string };
  id?: number | string;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    uri?: string;
    arguments?: Record<string, string>;
  };
  result?: unknown;
}

const ECHO = {
  description: "Returns the text it is given",
  inputSchema: {
    properties: { text: { type: "string" } },
    required: ["text"],
    type: "object",
  },
  name: "echo",
};
const EMPTY_INPUT = { properties: {}, type: "object" };
const tools = [
  ECHO,
  { description: "Adds a tool", inputSchema: EMPTY_INPUT, name: "grow" },
  { description: "Asks the user", inputSchema: EMPTY_INPUT, name: "ask" },
  { description: "Logs a line", inputSchema: EMPTY_INPUT, name: "log" },
  { description: "Writes to stderr", inputSchema: EMPTY_INPUT, name: "stderr" },
  { description: "Exits with code 3", inputSchema: EMPTY_INPUT, name: "die" },
];

let nextId = 1;
const pending = new Map<number, (message: Message) => void>();

function send(message: object): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function request(method: string, params: unknown): Promise<Message> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
  });
}

function text(value: string) {
  return { content: [{ text: value, type: "text" }] };
}

async function callTool(params: Message["params"]): Promise<unknown> {
  switch (params?.name ?? "") {
    case "echo":
      return text(params?.arguments?.text ?? "");
    case "grow":
      tools.push({
        description: "Louder echo",
        inputSchema: EMPTY_INPUT,
        name: "shout",
      });
      send({ method: "notifications/tools/list_changed" });
      return text("grown");
    case "ask": {
      const answer = await request("elicitation/create", {
        message: "What is your name?",
        requestedSchema: {
          properties: { name: { title: "Name", type: "string" } },
          required: ["name"],
          type: "object",
        },
      });
      return text(JSON.stringify(answer.error ?? answer.result));
    }
    case "log":
      send({
        method: "notifications/message",
        params: { data: "careful", level: "warning", logger: "fixture" },
      });
      return text("logged");
    case "stderr":
      process.stderr.write("first line\nsecond line\n");
      return text("written");
    case "die":
      // Let the result flush before exiting so the call itself succeeds.
      setTimeout(() => process.exit(3), 20);
      return text("bye");
    default:
      throw new Error(`Unknown tool: ${params?.name}`);
  }
}

async function handle(message: Message): Promise<void> {
  if (message.method === undefined) {
    if (typeof message.id === "number") {
      pending.get(message.id)?.(message);
    }
    return;
  }
  if (message.id === undefined) {
    return; // notifications need no reply
  }
  const { id, method, params } = message;
  try {
    switch (method) {
      case "initialize":
        send({
          id,
          result: {
            capabilities: {
              logging: {},
              prompts: {},
              resources: {},
              tools: { listChanged: true },
            },
            instructions: "Echo back what you are given.",
            protocolVersion: params?.protocolVersion,
            serverInfo: { name: "echo-fixture", version: "0.0.0" },
          },
        });
        return;
      case "tools/list":
        send({ id, result: { tools } });
        return;
      case "tools/call":
        send({ id, result: await callTool(params) });
        return;
      case "resources/list":
        send({
          id,
          result: {
            resources: [
              { mimeType: "text/plain", name: "hello", uri: "memo://hello" },
            ],
          },
        });
        return;
      case "resources/read":
        send({
          id,
          result: {
            contents: [
              { mimeType: "text/plain", text: "hi there", uri: params?.uri },
            ],
          },
        });
        return;
      case "prompts/list":
        send({
          id,
          result: {
            prompts: [
              {
                arguments: [{ name: "name", required: true }],
                description: "Greets someone",
                name: "greet",
              },
            ],
          },
        });
        return;
      case "prompts/get":
        send({
          id,
          result: {
            messages: [
              {
                content: {
                  text: `Hello, ${params?.arguments?.name ?? "stranger"}!`,
                  type: "text",
                },
                role: "user",
              },
            ],
          },
        });
        return;
      default:
        send({
          error: { code: -32_601, message: `Method not found: ${method}` },
          id,
        });
    }
  } catch (err) {
    send({ error: { code: -32_602, message: String(err) }, id });
  }
}

createInterface({ input: process.stdin }).on("line", (line: string) => {
  if (line.trim()) {
    void handle(JSON.parse(line) as Message);
  }
});
