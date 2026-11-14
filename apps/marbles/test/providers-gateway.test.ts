import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@foundry/models";
import { ModelManager } from "@foundry/models";
import { streamText } from "ai";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { catalog } from "~/authoring/catalog";
import { dispose, instanceRuntime } from "~/authoring/runtime";
import { createEngine } from "~/create";
import type { Engine } from "~/lib/engine";
import { ProviderConfiguration } from "~/lib/providers/configuration";
import type { ProviderPlugin } from "~/lib/providers/plugins";
import { gatewayPlugin, registered } from "~/lib/providers/plugins";

const ENV = { GW_KEY: "secret" };
const MISSING = /served\/missing/;
const UNSERVED = /openai\/gpt-5-mini/;
const NOT_LISTED = /^"gw" has no models; its models could not be listed: /;
const UNLISTED = /^its models could not be listed: /;
const DROPPED = /served\/chat/;
const PRINTED =
  /^\[providers\] "gw" has no models; its models could not be listed: /;

/** What the stub serves, how many times it was asked, and whether it answers. */
let served: string[] = [];
let asked = 0;
let hang = false;
let failing = false;
let server: Server;
let baseURL: string;
/** A port nothing listens on. */
let closedURL: string;
let state: string;

function listen(target: Server): Promise<string> {
  // Port 0: the system picks a free port. A bind error fails the hook at once.
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(target.address() as AddressInfo).port}/v1`)
    );
  });
}

beforeAll(async () => {
  // An OpenAI-compatible server: its model list, and one streamed answer.
  server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      asked += 1;
      if (hang) {
        return;
      }
      if (failing) {
        response.writeHead(500);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: served.map((id) => ({ id, object: "model" })),
          object: "list",
        })
      );
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = [
        { choices: [{ delta: { content: "ok" }, index: 0 }], id: "c" },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], id: "c" },
      ];
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  baseURL = await listen(server);
  const closed = createServer();
  closedURL = await listen(closed);
  await new Promise<void>((resolve) => closed.close(() => resolve()));
});

afterAll(() => {
  // A hanging request would hold the server open.
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  served = ["served/chat"];
  asked = 0;
  hang = false;
  failing = false;
  state = mkdtempSync(join(tmpdir(), "providers-gateway-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(state, { force: true, recursive: true });
});

/** A plugin that lists nothing and is always ready: the other providers. */
const other: ProviderPlugin<Record<string, never>> = {
  catalog: () => [{ id: "local", kind: "text", modelId: "local" }],
  create: ({ id, models }) => {
    const provider: Provider = {
      available: true,
      id,
      languageModel: () => ({}) as never,
      models,
      offline: false,
    };
    return { provider };
  },
  id: "other",
  label: "other",
  settings: z.object({}),
};

function configure(url: string, defaults?: Record<string, string>): string {
  const file = join(state, "providers.json");
  writeFileSync(
    file,
    JSON.stringify({
      providers: [
        {
          ...(defaults ? { defaults } : {}),
          enabled: true,
          id: "gw",
          plugin: "gateway",
          settings: { apiKey: "GW_KEY", baseURL: url },
        },
        { enabled: true, id: "other", plugin: "other" },
      ],
      version: 1,
    })
  );
  return file;
}

function configuration(): {
  readonly configuration: ProviderConfiguration;
  readonly models: ModelManager;
} {
  const models = new ModelManager();
  return {
    configuration: new ProviderConfiguration({
      environment: { machine: ENV, workspace: {} },
      models,
      plugins: [registered(gatewayPlugin), registered(other)],
      state,
    }),
    models,
  };
}

/** The model a selection routes to now, or undefined while it is refused. */
function routed(models: ModelManager, selection: string): string | undefined {
  try {
    return models.resolve("text", selection).model;
  } catch {
    return undefined;
  }
}

function entry(configured: ProviderConfiguration, id: string) {
  return configured.list().find((each) => each.id === id);
}

it("runs a model the gateway's server lists, and refuses one it does not", async () => {
  served = ["served/chat", "served/other"];
  configure(baseURL);
  const { configuration: configured, models } = configuration();
  try {
    configured.load();
    expect(entry(configured, "gw")).toMatchObject({
      problem: "its models have not been listed yet",
      state: "unavailable",
    });

    expect(await configured.refresh()).toEqual([]);
    expect(entry(configured, "gw")?.state).toBe("ready");
    const resolved = models.resolve("text", "gw/served/chat");
    expect(resolved.definition).toEqual({
      id: "served/chat",
      kind: "text",
      modelId: "served/chat",
    });
    const result = streamText({ model: resolved.open(), prompt: "hello" });
    expect(await result.text).toBe("ok");

    expect(() =>
      models.resolve("text", { model: "served/missing", provider: "gw" })
    ).toThrow(MISSING);
    expect(() =>
      models.resolve("text", { model: "openai/gpt-5-mini", provider: "gw" })
    ).toThrow(UNSERVED);
  } finally {
    await configured.dispose();
  }
});

it("checks a gateway's defaults against what its server lists", async () => {
  configure(baseURL, { text: "served/gone" });
  const { configuration: configured } = configuration();
  try {
    await configured.refresh();
    expect(entry(configured, "gw")).toMatchObject({
      problem: 'the default text model "served/gone" is not in the catalog',
      state: "unloadable",
    });
  } finally {
    await configured.dispose();
  }
});

it("starts without the gateway when its server cannot be reached, and says why", async () => {
  configure(closedURL);
  const { configuration: configured, models } = configuration();
  try {
    const [problem, ...rest] = await configured.refresh();
    expect(problem).toMatch(NOT_LISTED);
    expect(rest).toEqual([]);
    const gw = entry(configured, "gw");
    expect(gw?.state).toBe("unavailable");
    expect(gw?.problem).toMatch(UNLISTED);
    expect(entry(configured, "other")?.state).toBe("ready");
    expect(models.providers.map((provider) => provider.id)).toEqual(["other"]);
  } finally {
    await configured.dispose();
  }
});

it("gives up on a server that does not answer in time", {
  timeout: 15_000,
}, async () => {
  hang = true;
  configure(baseURL);
  const { configuration: configured } = configuration();
  try {
    expect(await configured.refresh()).toEqual([
      '"gw" has no models; its models could not be listed: no answer within 5 s',
    ]);
    expect(entry(configured, "gw")).toMatchObject({
      problem: "its models could not be listed: no answer within 5 s",
      state: "unavailable",
    });
    expect(entry(configured, "other")?.state).toBe("ready");
  } finally {
    await configured.dispose();
  }
});

it("picks up a changed list when the configuration reloads, and keeps the last list when the server fails", async () => {
  const file = configure(baseURL);
  const { configuration: configured, models } = configuration();
  const reported: string[] = [];
  const unwatch = configured.watch((problem) => reported.push(problem));
  try {
    await configured.refresh();
    expect(models.resolve("text", "gw/served/chat").model).toBe("served/chat");

    // The file is unchanged; only the server's list is.
    served = ["served/next"];
    const touch = (seconds: number) => {
      const at = new Date(Date.now() + seconds * 1000);
      utimesSync(file, at, at);
    };
    touch(5);
    await expect
      .poll(() => routed(models, "gw/served/next"))
      .toBe("served/next");
    expect(() => models.resolve("text", "gw/served/chat")).toThrow(DROPPED);

    // A list that fails now keeps the one before, and is reported.
    failing = true;
    touch(10);
    await expect.poll(() => reported.length).toBeGreaterThan(0);
    expect(reported[0]).toBe(
      '"gw" kept its last model list; its models could not be listed: GET /models answered 500'
    );
    expect(models.resolve("text", "gw/served/next").model).toBe("served/next");
  } finally {
    unwatch();
    await configured.dispose();
  }
});

it("asks no server while Airplane Mode is on, and asks again when it is off", async () => {
  configure(baseURL);
  const engine = createEngine({
    catalog,
    dry: false,
    environment: { machine: ENV, workspace: {} },
    plugins: [registered(gatewayPlugin), registered(other)],
    print: () => undefined,
    root: state,
    stateRoot: state,
    workspaceId: "ws",
  });
  try {
    engine.airplane.set(true);
    await engine.start();
    expect(asked).toBe(0);
    expect(
      engine.providers?.list().find((each) => each.id === "gw")
    ).toMatchObject({ state: "unavailable" });

    engine.airplane.set(false);
    await expect
      .poll(() => engine.models.providers.map((provider) => provider.id))
      .toEqual(["gw", "other"]);
    expect(asked).toBe(1);
    expect(engine.models.resolve("text", "gw/served/chat").provider).toBe("gw");
  } finally {
    await engine.dispose();
  }
});

it("lists the gateway's models when the engine starts", async () => {
  configure(baseURL);
  const engine = createEngine({
    catalog,
    dry: false,
    environment: { machine: ENV, workspace: {} },
    plugins: [registered(gatewayPlugin), registered(other)],
    print: () => undefined,
    root: state,
    stateRoot: state,
    workspaceId: "ws",
  });
  try {
    await engine.start();
    expect(asked).toBe(1);
    expect(engine.models.resolve("text", "gw/served/chat").provider).toBe("gw");
  } finally {
    await engine.dispose();
  }
});

it("adds a gateway entry and serves what its server lists", async () => {
  const { configuration: configured, models } = configuration();
  try {
    await configured.add(
      {
        id: "gw",
        plugin: "gateway",
        settings: { apiKey: "GW_KEY", baseURL },
      },
      { scope: "machine" }
    );
    expect(entry(configured, "gw")?.state).toBe("ready");
    expect(models.resolve("text", "gw/served/chat").model).toBe("served/chat");
  } finally {
    await configured.dispose();
  }
});

function engineOver(print: (line: string) => void): Engine {
  return createEngine({
    catalog,
    dry: false,
    environment: { machine: ENV, workspace: {} },
    plugins: [registered(gatewayPlugin), registered(other)],
    print,
    root: state,
    stateRoot: state,
    workspaceId: "ws",
  });
}

it("starts when the gateway gives no list, and prints why", async () => {
  configure(closedURL);
  const lines: string[] = [];
  const engine = engineOver((line) => lines.push(line));
  try {
    await engine.start();
    expect(lines.filter((line) => line.startsWith("[providers]"))).toEqual([
      expect.stringMatching(PRINTED),
    ]);
    expect(engine.models.providers.map((provider) => provider.id)).toEqual([
      "other",
    ]);
  } finally {
    await engine.dispose();
  }
});

it("starts when providers.json became unreadable after the engine was built", async () => {
  const file = configure(baseURL);
  const lines: string[] = [];
  const engine = engineOver((line) => lines.push(line));
  try {
    writeFileSync(file, "not json");
    await engine.start();
    expect(lines.some((line) => line.startsWith("[providers]"))).toBe(true);
  } finally {
    await engine.dispose();
  }
});

it("lists the gateway's models for definitions called outside a run", async () => {
  const home = join(state, "home");
  mkdirSync(join(home, "marbles"), { recursive: true });
  writeFileSync(
    join(home, "marbles", "providers.json"),
    JSON.stringify({
      providers: [
        {
          enabled: true,
          id: "gw",
          plugin: "gateway",
          settings: { apiKey: "GW_KEY", baseURL },
        },
      ],
      version: 1,
    })
  );
  vi.stubEnv("FOUNDRY_HOME", home);
  vi.stubEnv("GW_KEY", "secret");
  try {
    const runtime = (await instanceRuntime()) as Engine;
    expect(runtime.models.resolve("text", "gw/served/chat").provider).toBe(
      "gw"
    );
  } finally {
    await dispose();
  }
});
