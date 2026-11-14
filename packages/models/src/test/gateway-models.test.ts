import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatewayModels } from "../gateway";

/** What the stub answers on `GET /models`. */
let answer: { body: string; status: number } = { body: "{}", status: 200 };
const seen: { authorization?: string; url?: string }[] = [];
let server: Server;
let baseURL: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({
      ...(request.headers.authorization
        ? { authorization: request.headers.authorization }
        : {}),
      ...(request.url ? { url: request.url } : {}),
    });
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(answer.body);
  });
  // Port 0: the system picks a free port. A bind error fails the hook at once.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("gatewayModels", () => {
  it("lists each id the server serves as a text model, and nothing else", async () => {
    answer = {
      body: JSON.stringify({
        data: [
          { id: "served/one", object: "model", owned_by: "someone" },
          { id: "served/two", object: "model" },
          { id: "served/one", object: "model" },
          { object: "model" },
          { id: 7 },
        ],
        object: "list",
      }),
      status: 200,
    };
    const models = await gatewayModels({
      apiKey: "secret",
      baseURL: `${baseURL}/`,
      queryParams: { v: "1" },
    });
    expect(models).toEqual([
      { id: "served/one", kind: "text", modelId: "served/one" },
      { id: "served/two", kind: "text", modelId: "served/two" },
    ]);
    expect(seen.at(-1)).toEqual({
      authorization: "Bearer secret",
      url: "/v1/models?v=1",
    });
  });

  it("rejects with the status when the server refuses", async () => {
    answer = { body: '{"error":"no key"}', status: 401 };
    await expect(gatewayModels({ baseURL })).rejects.toThrow(
      "GET /models answered 401"
    );
  });

  it("rejects an answer that is not a model list", async () => {
    answer = { body: "<html>", status: 200 };
    await expect(gatewayModels({ baseURL })).rejects.toThrow(
      "GET /models answered without a model list"
    );
  });
});
