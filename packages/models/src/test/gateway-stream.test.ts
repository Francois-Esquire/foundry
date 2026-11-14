import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { streamText } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gatewayProvider } from "../gateway";

/** The chunks an OpenAI-compatible server streams, with usage last as `stream_options` asks. */
const CHUNKS = [
  {
    choices: [{ delta: { content: "hi", role: "assistant" }, index: 0 }],
    id: "c1",
    model: "openai/gpt-5-mini",
  },
  {
    choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
    id: "c1",
    model: "openai/gpt-5-mini",
  },
  {
    choices: [],
    id: "c1",
    model: "openai/gpt-5-mini",
    usage: {
      completion_tokens: 5,
      prompt_tokens: 12,
      prompt_tokens_details: { cached_tokens: 4 },
      total_tokens: 17,
    },
  },
];

const bodies: Record<string, unknown>[] = [];
let server: Server;
let baseURL: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    request.on("end", () => {
      const body = JSON.parse(text) as Record<string, unknown>;
      bodies.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      // Usage is sent only when the request asked for it, as OpenAI does.
      const asked =
        (body.stream_options as { include_usage?: boolean } | undefined)
          ?.include_usage === true;
      for (const chunk of asked ? CHUNKS : CHUNKS.slice(0, 2)) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  // Port 0: the system picks a free port. A bind error fails the hook at once.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("gatewayProvider streaming", () => {
  it("asks for usage on a stream and reports the turn's tokens", async () => {
    const provider = gatewayProvider({ config: { apiKey: "k", baseURL } });
    const result = streamText({
      model: provider.languageModel("openai/gpt-5-mini"),
      prompt: "hello",
    });
    expect(await result.text).toBe("hi");
    const usage = await result.totalUsage;

    expect(bodies.at(-1)?.stream_options).toEqual({ include_usage: true });
    expect(usage.inputTokens).toBe(12);
    expect(usage.outputTokens).toBe(5);
    expect(usage.inputTokenDetails.cacheReadTokens).toBe(4);
  });
});
