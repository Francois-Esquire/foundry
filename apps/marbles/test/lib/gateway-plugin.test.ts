import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { streamText } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderSetup } from "~/lib/providers/plugins";
import { gatewayPlugin } from "~/lib/providers/plugins";

type Settings = Parameters<typeof gatewayPlugin.create>[0]["settings"];

const requests: { authorization?: string; body: Record<string, unknown> }[] =
  [];
let server: Server;
let baseURL: string;

beforeAll(async () => {
  // An OpenAI-compatible chat server: one streamed answer, and its usage
  // when the request asks for it.
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    request.on("end", () => {
      const body = JSON.parse(text) as Record<string, unknown>;
      requests.push({
        ...(request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {}),
        body,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunks: unknown[] = [
        { choices: [{ delta: { content: "ok" }, index: 0 }], id: "c" },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], id: "c" },
      ];
      if (body.stream_options) {
        chunks.push({
          choices: [],
          id: "c",
          usage: { completion_tokens: 2, prompt_tokens: 7, total_tokens: 9 },
        });
      }
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function setup(
  settings: Settings,
  env: Record<string, string> = {}
): ProviderSetup<Settings> {
  return {
    env,
    id: "gw",
    models: gatewayPlugin.catalog(settings),
    scope: "machine",
    settings,
  };
}

describe("gatewayPlugin", () => {
  it("takes a base URL and the name of its key's variable, and refuses any other setting", () => {
    expect(
      gatewayPlugin.settings.safeParse({ apiKey: "GW_KEY", baseURL }).success
    ).toBe(true);
    const unknown = gatewayPlugin.settings.safeParse({
      baseURL,
      model: "openai/gpt-5",
    });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.issues[0]?.code).toBe("unrecognized_keys");
    expect(gatewayPlugin.secrets).toEqual(["apiKey"]);
  });

  it("builds an instance under its id, available once the named key is set", () => {
    const keyed = gatewayPlugin.create(
      setup({ apiKey: "GW_KEY", baseURL }, { GW_KEY: "secret" })
    );
    expect(keyed.provider.id).toBe("gw");
    expect(keyed.provider.available).toBe(true);
    expect(keyed.execution).toBeUndefined();

    const unset = gatewayPlugin.create(setup({ apiKey: "GW_KEY", baseURL }));
    expect(unset.provider.available).toBe(false);
  });

  it("streams a turn through the gateway with its key and reports the turn's tokens", async () => {
    const { provider } = gatewayPlugin.create(
      setup({ apiKey: "GW_KEY", baseURL }, { GW_KEY: "secret" })
    );
    const [row] = provider.models.filter((model) => model.kind === "text");
    const result = streamText({
      model: provider.languageModel(row?.modelId ?? ""),
      prompt: "hello",
    });
    expect(await result.text).toBe("ok");
    const usage = await result.totalUsage;

    const sent = requests.at(-1);
    expect(sent?.authorization).toBe("Bearer secret");
    expect(sent?.body.stream_options).toEqual({ include_usage: true });
    expect(usage.inputTokens).toBe(7);
    expect(usage.outputTokens).toBe(2);
  });
});
