import type { Provider } from "@foundry/models";
import { ModelManager } from "@foundry/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { environmentSnapshot } from "~/lib/environment";
import { refusingWhenChanged } from "~/lib/providers/account";
import type {
  ProviderConfigurationOptions,
  ScopedRecord,
} from "~/lib/providers/configuration";
import { ProviderConfiguration } from "~/lib/providers/configuration";
import type { ProviderPlugin, ProviderSetup } from "~/lib/providers/plugins";
import {
  claudeCodePlugin,
  codexPlugin,
  piPlugin,
  registered,
} from "~/lib/providers/plugins";
import type {
  ProviderConfigurations,
  ProviderStore,
  ProviderWrites,
} from "~/lib/providers/store";
import {
  ConfigurationError,
  identityKeyFrom,
  keptConfigurations,
  MACHINE_SCOPE,
  newIdentityKey,
  writtenTexts,
} from "~/lib/providers/store";

class TestStore implements ProviderStore {
  readonly texts = new Map<string, string>();
  key: string | undefined;
  revisions = 0;
  between: (() => void) | undefined;
  refusing: { key: Error[]; read: Error[]; revision: Error[] } = {
    key: [],
    read: [],
    revision: [],
  };
  reads = 0;
  revisionReads = 0;
  keyAsks = 0;
  #held: Promise<undefined> = Promise.resolve(undefined);

  put(scope: string, file: object): void {
    this.texts.set(scope, JSON.stringify({ version: 1, ...file }));
    this.revisions += 1;
  }

  hold(): { release(): void } {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    this.#held = promise;
    return { release: () => resolve(undefined) };
  }

  identityKey(make: boolean): Promise<Buffer | undefined> {
    this.keyAsks += 1;
    const refusal = this.refusing.key.shift();
    if (refusal !== undefined) {
      return Promise.reject(refusal);
    }
    if (make) {
      this.key ??= newIdentityKey();
    }
    try {
      return Promise.resolve(
        this.key === undefined ? undefined : identityKeyFrom(this.key)
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  read(): Promise<ProviderConfigurations> {
    this.reads += 1;
    const refusal = this.refusing.read.shift();
    if (refusal !== undefined) {
      return Promise.reject(refusal);
    }
    try {
      return Promise.resolve(
        keptConfigurations(new Map(this.texts), this.revisions)
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  revision(): Promise<number> {
    this.revisionReads += 1;
    const refusal = this.refusing.revision.shift();
    if (refusal !== undefined) {
      return Promise.reject(refusal);
    }
    return Promise.resolve(this.revisions);
  }

  async update(
    workspace: string | undefined,
    edit: (current: ProviderConfigurations) => ProviderWrites
  ): Promise<ProviderConfigurations> {
    await this.#held;
    const written = writtenTexts(
      workspace,
      edit(keptConfigurations(new Map(this.texts), this.revisions))
    );
    for (const [scope, text] of written) {
      this.texts.set(scope, text);
    }
    if (written.size > 0) {
      this.revisions += 1;
    }
    const landed = keptConfigurations(new Map(this.texts), this.revisions);
    this.between?.();
    return landed;
  }
}

const busy = (message = "the database is locked") =>
  new ConfigurationError("CONFIGURATION_BUSY", message);

let store: TestStore;
const seen = new Map<string, ProviderSetup<{ key?: string }>>();

function plugin(
  id: string,
  extra: Partial<ProviderPlugin<{ key?: string }>> = {}
): ProviderPlugin<{ key?: string }> {
  return {
    catalog: () => [
      { id: `${id}-model`, kind: "text", modelId: `${id}-model` },
    ],
    create: (setup) => {
      seen.set(setup.id, setup);
      const provider: Provider = {
        available: true,
        dispose: vi.fn(() => Promise.resolve()),
        id: setup.id,
        languageModel: () => ({}) as never,
        models: setup.models,
        offline: false,
      };
      return { provider };
    },
    detect: () => ({}),
    id,
    label: id,
    secrets: ["key"],
    settings: z.object({ key: z.string().optional() }),
    ...extra,
  };
}

const PLUGINS = [
  registered(plugin("codex")),
  registered(plugin("vercel")),
  registered(plugin("bedrock", { binding: "workspace" })),
  registered(plugin("pi", { ambient: true })),
  registered(
    plugin("broken", {
      create: () => {
        throw new Error("create exploded");
      },
      detect: () => null,
    })
  ),
  registered(
    plugin("uncatalogued", {
      catalog: () => {
        throw new Error("catalog exploded");
      },
      detect: () => null,
    })
  ),
];

async function loaded(config: ProviderConfiguration): Promise<void> {
  await config.read();
  config.load();
}

function configuration(
  environment: Record<string, string> = { PATH: "/bin" },
  options: Partial<ProviderConfigurationOptions> = {}
) {
  const models = new ModelManager();
  const config = new ProviderConfiguration({
    environment,
    models,
    plugins: PLUGINS,
    store,
    workspace: { dir: "/state/ws1", id: "ws1", root: "/repo" },
    ...options,
  });
  return { config, models };
}

const ids = (models: ModelManager) => models.providers.map((p) => p.id);

beforeEach(() => {
  store = new TestStore();
  seen.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function matchProcessEnv(
  patterns: readonly string[],
  env: Readonly<Record<string, string>>
): void {
  const covers = (name: string) =>
    patterns.some((pattern) =>
      pattern.endsWith("*")
        ? name.startsWith(pattern.slice(0, -1))
        : name === pattern
    );
  for (const name of Object.keys(process.env).filter(covers)) {
    vi.stubEnv(name, undefined);
  }
  for (const [name, value] of Object.entries(env).filter(([key]) =>
    covers(key)
  )) {
    vi.stubEnv(name, value);
  }
}

describe("the effective set", () => {
  it("puts workspace entries before machine entries, in file order", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [
        { enabled: true, id: "codex", plugin: "codex" },
        { enabled: true, id: "vercel", plugin: "vercel" },
      ],
    });
    store.put("ws1", {
      providers: [{ enabled: true, id: "acme-bedrock", plugin: "bedrock" }],
    });
    const { config, models } = configuration();
    await loaded(config);
    expect(ids(models)).toEqual(["acme-bedrock", "codex", "vercel"]);
    expect(seen.get("acme-bedrock")?.workspace).toMatchObject({ id: "ws1" });
    expect(seen.get("codex")?.workspace).toBeUndefined();
  });

  it("uses exactly what a workspace order lists, in that order", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [
        { enabled: true, id: "codex", plugin: "codex" },
        { enabled: true, id: "vercel", plugin: "vercel" },
      ],
    });
    store.put("ws1", {
      order: ["vercel"],
      providers: [],
    });
    const { config, models } = configuration();
    await loaded(config);
    expect(ids(models)).toEqual(["vercel"]);
    expect(config.list().find((entry) => entry.id === "codex")).toMatchObject({
      problem: "not in this workspace's order",
      state: "excluded",
    });
  });

  it("uses neither entry when one id is configured at both scopes", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    store.put("ws1", {
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    const { config, models } = configuration();
    await loaded(config);
    expect(ids(models)).toEqual([]);
    expect(config.list().map((entry) => entry.state)).toEqual([
      "unloadable",
      "unloadable",
    ]);
  });

  it("keeps entries it cannot load, and reports why", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [
        { enabled: true, id: "bound", plugin: "bedrock" },
        { enabled: true, id: "mystery", plugin: "@acme/unknown" },
        {
          enabled: true,
          id: "literal",
          plugin: "vercel",
          settings: { key: "sk-123" },
        },
        { enabled: false, id: "codex", plugin: "codex" },
      ],
    });
    const { config, models } = configuration();
    await loaded(config);
    expect(ids(models)).toEqual([]);
    const problems = Object.fromEntries(
      config.list().map((entry) => [entry.id, entry.problem])
    );
    expect(problems).toEqual({
      bound: '"bedrock" must be configured for a workspace',
      codex: "disabled",
      literal: '"key" must name an environment variable, not hold a value',
      mystery: 'no plugin "@acme/unknown" is registered',
    });
  });
});

describe("environments by scope", () => {
  it("gives machine and workspace entries the same environment", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    store.put("ws1", {
      providers: [{ enabled: true, id: "vercel", plugin: "vercel" }],
    });
    const { config } = configuration({ PATH: "/bin", TOKEN: "host" });
    await loaded(config);
    expect(seen.get("codex")?.env).toEqual({ PATH: "/bin", TOKEN: "host" });
    expect(seen.get("vercel")?.env).toEqual({ PATH: "/bin", TOKEN: "host" });
  });
});

describe("edits", () => {
  it("persists edits, reloads the set, and keeps an unchanged instance", async () => {
    const { config, models } = configuration();
    await config.add({ id: "codex", plugin: "codex" }, { scope: "machine" });
    const [codex] = models.providers;
    await config.add(
      { id: "vercel", plugin: "vercel" },
      { index: 0, scope: "machine" }
    );
    expect(ids(models)).toEqual(["vercel", "codex"]);
    expect(models.providers[1]).toBe(codex);

    await config.move("codex", 0, "workspace");
    expect(ids(models)).toEqual(["codex", "vercel"]);
    await config.setOrder(undefined);
    expect(ids(models)).toEqual(["vercel", "codex"]);
    await config.disable("vercel");
    expect(ids(models)).toEqual(["codex"]);
    await config.remove("vercel");
    expect(config.list().map((entry) => entry.id)).toEqual(["codex"]);

    const reloaded = configuration();
    await loaded(reloaded.config);
    expect(ids(reloaded.models)).toEqual(["codex"]);
  });

  describe("lists a provider an edit brings into the order", () => {
    const LISTING = [
      ...PLUGINS,
      registered(
        plugin("listed", {
          list: () =>
            Promise.resolve([
              { id: "listed-model", kind: "text", modelId: "listed-model" },
            ]),
        })
      ),
    ];
    const stateOf = (config: ProviderConfiguration, id: string) =>
      config.list().find((entry) => entry.id === id)?.state;
    const machineWithListed = () =>
      store.put(MACHINE_SCOPE, {
        providers: [
          { enabled: true, id: "codex", plugin: "codex" },
          { enabled: true, id: "listed", plugin: "listed" },
        ],
      });

    it("after setOrder", async () => {
      machineWithListed();
      store.put("ws1", { order: ["codex"], providers: [] });
      const { config } = configuration(undefined, { plugins: LISTING });
      await config.refresh();
      expect(stateOf(config, "listed")).toBe("excluded");
      await config.setOrder(undefined);
      expect(stateOf(config, "listed")).toBe("ready");
      await config.dispose();
    });

    it("after move", async () => {
      machineWithListed();
      store.put("ws1", { order: ["codex"], providers: [] });
      const { config } = configuration(undefined, { plugins: LISTING });
      await config.refresh();
      await config.move("listed", 0, "workspace");
      expect(stateOf(config, "listed")).toBe("ready");
      await config.dispose();
    });

    it("after remove leaves one enabled entry of an id", async () => {
      store.put(MACHINE_SCOPE, {
        providers: [{ enabled: true, id: "listed", plugin: "listed" }],
      });
      store.put("ws1", {
        providers: [{ enabled: true, id: "listed", plugin: "listed" }],
      });
      const { config } = configuration(undefined, { plugins: LISTING });
      await config.refresh();
      expect(stateOf(config, "listed")).toBe("unloadable");
      await config.remove("listed");
      expect(config.list()).toMatchObject([
        { id: "listed", scope: "machine", state: "ready" },
      ]);
      await config.dispose();
    });
  });

  it("refuses an id taken at the other scope, a bound plugin at machine scope, and a literal secret", async () => {
    store.put("ws2", {
      providers: [{ enabled: true, id: "shared", plugin: "codex" }],
    });
    const { config } = configuration();
    await config.add({ id: "codex", plugin: "codex" }, { scope: "machine" });
    await expect(
      config.add({ id: "codex", plugin: "codex" }, { scope: "workspace" })
    ).rejects.toMatchObject({ code: "PROVIDER_ID_TAKEN" });
    await expect(
      config.add({ id: "shared", plugin: "codex" }, { scope: "machine" })
    ).rejects.toMatchObject({ code: "PROVIDER_ID_TAKEN" });
    await expect(
      config.add({ id: "b", plugin: "bedrock" }, { scope: "machine" })
    ).rejects.toThrow("must be configured for a workspace");
    await expect(
      config.add(
        { id: "v", plugin: "vercel", settings: { key: "sk-literal" } },
        { scope: "machine" }
      )
    ).rejects.toThrow("must name an environment variable");
  });

  it("adds a machine entry to a store that keeps nothing yet", async () => {
    const { config, models } = configuration();
    await config.add({ id: "codex", plugin: "codex" }, { scope: "machine" });
    expect(ids(models)).toEqual(["codex"]);
  });

  it("refuses to read an unreadable file, and the watcher keeps the last good set", async () => {
    const { config, models } = configuration();
    await config.add({ id: "codex", plugin: "codex" }, { scope: "machine" });
    const problems: string[] = [];
    const stop = config.watch((problem) => problems.push(problem));
    store.texts.set(MACHINE_SCOPE, "{ broken");
    store.revisions += 1;
    await vi.waitFor(() => expect(problems.length).toBeGreaterThan(0), {
      timeout: 5000,
    });
    await new Promise((settle) => setTimeout(settle, 1500));
    expect(problems).toHaveLength(1);
    expect(ids(models)).toEqual(["codex"]);
    store.put(MACHINE_SCOPE, {
      providers: [
        { enabled: true, id: "codex", plugin: "codex" },
        { enabled: true, id: "vercel", plugin: "vercel" },
      ],
    });
    await vi.waitFor(() => expect(ids(models)).toEqual(["codex", "vercel"]), {
      timeout: 5000,
    });
    stop();
    store.texts.set(MACHINE_SCOPE, "{ broken");
    await expect(loaded(configuration().config)).rejects.toThrow(
      expect.objectContaining({ code: "CONFIGURATION_UNREADABLE" })
    );
  });
});

describe("a configuration and the store's revision", () => {
  it("digests a first configuration's identities with the key the store keeps, so they survive a restart", async () => {
    const { config } = configuration();
    await config.read();
    expect(store.key).toBeUndefined();
    await config.initialize([{ enabled: true, id: "codex", plugin: "codex" }]);
    expect(store.key).toEqual(expect.any(String));
    const first = config.identityOf("codex");
    const restarted = configuration().config;
    await loaded(restarted);
    expect(restarted.identityOf("codex")).toBe(first);
  });

  it("keeps the revision its own write left, so the watcher sees an edit another process committed right after it", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    const { config, models } = configuration();
    await loaded(config);
    const stop = config.watch(() => undefined);
    try {
      store.between = () => {
        store.between = undefined;
        store.put(MACHINE_SCOPE, {
          providers: [
            { enabled: true, id: "codex", plugin: "codex" },
            { enabled: true, id: "vercel", plugin: "vercel" },
          ],
        });
      };
      await config.disable("codex");
      expect(ids(models)).toEqual([]);
      await vi.waitFor(() => expect(ids(models)).toEqual(["codex", "vercel"]), {
        timeout: 5000,
      });
    } finally {
      stop();
    }
  });
});

describe("a store that could not be reached", () => {
  const codex = {
    providers: [{ enabled: true, id: "codex", plugin: "codex" }],
  };

  function watched(config: ProviderConfiguration) {
    const problems: string[] = [];
    const stop = config.watch((problem) => problems.push(problem));
    return { problems, stop };
  }

  it("is tried again when the identity key could not be made as the engine started", async () => {
    store.put(MACHINE_SCOPE, codex);
    const { config, models } = configuration();
    store.refusing.key = [busy()];
    await expect(config.refresh()).rejects.toThrow("locked");
    const { stop } = watched(config);
    try {
      await vi.waitFor(() => expect(ids(models)).toEqual(["codex"]), {
        timeout: 5000,
      });
    } finally {
      stop();
    }
  });

  it("is tried again when the configuration could not be read as the engine started", async () => {
    store.put(MACHINE_SCOPE, codex);
    const { config, models } = configuration();
    store.refusing.read = [busy()];
    await expect(config.refresh()).rejects.toThrow("locked");
    const { stop } = watched(config);
    try {
      await vi.waitFor(() => expect(ids(models)).toEqual(["codex"]), {
        timeout: 5000,
      });
    } finally {
      stop();
    }
  });

  it("reports a failure it keeps meeting once, a new one again, and its recovery once", async () => {
    store.put(MACHINE_SCOPE, codex);
    const { config, models } = configuration();
    store.refusing.key = [busy(), busy(), busy(), busy("still locked")];
    await expect(config.refresh()).rejects.toThrow("the database is locked");
    const { problems, stop } = watched(config);
    try {
      await vi.waitFor(() => expect(ids(models)).toEqual(["codex"]), {
        timeout: 8000,
      });
      expect(problems).toEqual([
        "still locked",
        "the provider configuration can be read again",
      ]);
    } finally {
      stop();
    }
  });

  it("reports a revision read that keeps failing once, and its recovery only once that read succeeds", async () => {
    store.put(MACHINE_SCOPE, codex);
    const { config } = configuration();
    await config.refresh();
    store.refusing.revision = Array.from({ length: 4 }, () =>
      busy("the revision is locked")
    );
    const { problems, stop } = watched(config);
    try {
      await vi.waitFor(() => expect(store.revisionReads).toBe(4), {
        timeout: 8000,
      });
      expect(problems).toEqual(["the revision is locked"]);
      await vi.waitFor(() => expect(store.revisionReads).toBe(5), {
        timeout: 5000,
      });
      await vi.waitFor(() =>
        expect(problems).toEqual([
          "the revision is locked",
          "the provider configuration can be read again",
        ])
      );
    } finally {
      stop();
    }
  });

  it("recovers a configuration read that failed only once that read succeeds", async () => {
    store.put(MACHINE_SCOPE, codex);
    const { config, models } = configuration();
    store.refusing.read = [busy(), busy(), busy()];
    await expect(config.refresh()).rejects.toThrow("the database is locked");
    const { problems, stop } = watched(config);
    try {
      await vi.waitFor(() => expect(ids(models)).toEqual(["codex"]), {
        timeout: 8000,
      });
      expect(store.reads).toBe(4);
      expect(problems).toEqual([
        "the provider configuration can be read again",
      ]);
    } finally {
      stop();
    }
  });

  it("recovers an identity key that could not be made only once it is, though the configuration reads", async () => {
    store.put(MACHINE_SCOPE, codex);
    const { config, models } = configuration();
    store.refusing.key = [busy("no key"), busy("no key"), busy("no key")];
    await expect(config.refresh()).rejects.toThrow("no key");
    const { problems, stop } = watched(config);
    try {
      await vi.waitFor(() => expect(store.keyAsks).toBe(3), { timeout: 8000 });
      expect(problems).toEqual([]);
      await vi.waitFor(() => expect(ids(models)).toEqual(["codex"]), {
        timeout: 5000,
      });
      expect(problems).toEqual([
        "the provider configuration can be read again",
      ]);
    } finally {
      stop();
    }
  });

  it("reports a configuration that cannot be read once, though the identity key could not be made before it", async () => {
    store.put(MACHINE_SCOPE, codex);
    const { config } = configuration();
    store.refusing.key = Array.from({ length: 50 }, () => busy("no key"));
    await expect(config.refresh()).rejects.toThrow("no key");
    const { problems, stop } = watched(config);
    try {
      await vi.waitFor(() => expect(store.keyAsks).toBeGreaterThan(1), {
        timeout: 5000,
      });
      store.texts.set(MACHINE_SCOPE, "{ broken");
      store.revisions += 1;
      await vi.waitFor(() => expect(problems).toHaveLength(1), {
        timeout: 5000,
      });
      expect(problems[0]).toContain("cannot be read");
      const { reads } = store;
      await new Promise((settle) => setTimeout(settle, 1650));
      expect(store.reads).toBe(reads);
      expect(problems).toHaveLength(1);
    } finally {
      stop();
    }
  }, 15_000);

  it("stops asking for an identity key once nothing configured needs one, and reports no recovery for it", async () => {
    store.put(MACHINE_SCOPE, codex);
    const { config } = configuration();
    store.refusing.key = Array.from({ length: 50 }, () => busy("no key"));
    await expect(config.refresh()).rejects.toThrow("no key");
    const { problems, stop } = watched(config);
    try {
      await vi.waitFor(() => expect(store.keyAsks).toBeGreaterThan(1), {
        timeout: 5000,
      });
      store.texts.delete(MACHINE_SCOPE);
      store.revisions += 1;
      await vi.waitFor(() => expect(store.reads).toBeGreaterThan(2), {
        timeout: 5000,
      });
      await new Promise((settle) => setTimeout(settle, 1100));
      const { reads } = store;
      await new Promise((settle) => setTimeout(settle, 1650));
      expect(store.reads).toBe(reads);
      expect(problems).toEqual([]);
    } finally {
      stop();
    }
  }, 15_000);

  it("reports a recovery an edit made outside a poll on the next poll", async () => {
    store.put(MACHINE_SCOPE, codex);
    const { config } = configuration();
    store.refusing.key = [busy()];
    await expect(config.refresh()).rejects.toThrow("the database is locked");
    const { problems, stop } = watched(config);
    try {
      await config.add(
        { id: "vercel", plugin: "vercel" },
        { scope: "machine" }
      );
      await vi.waitFor(() => expect(problems).toHaveLength(1), {
        timeout: 5000,
      });
      expect(problems).toEqual([
        "the provider configuration can be read again",
      ]);
      await new Promise((settle) => setTimeout(settle, 1100));
      expect(problems).toHaveLength(1);
    } finally {
      stop();
    }
  }, 15_000);

  it("notices a stored identity key that is not one being removed, though no revision moves", async () => {
    store.put(MACHINE_SCOPE, codex);
    store.key = "not a key";
    const { config, models } = configuration();
    await expect(config.refresh()).rejects.toThrow("the identity key");
    const { problems, stop } = watched(config);
    try {
      store.key = undefined;
      await vi.waitFor(() => expect(ids(models)).toEqual(["codex"]), {
        timeout: 10_000,
      });
      expect(store.key).toEqual(expect.any(String));
      expect(problems).toEqual([]);
    } finally {
      stop();
    }
  }, 20_000);

  it("reports a stored identity key that is not one once, though asking for it failed before, and asks no more until the revision changes", async () => {
    store.put(MACHINE_SCOPE, codex);
    store.key = "not a key";
    store.refusing.key = [busy()];
    const { config } = configuration();
    await expect(config.refresh()).rejects.toThrow("the database is locked");
    const { problems, stop } = watched(config);
    try {
      await vi.waitFor(() => expect(problems).toHaveLength(1), {
        timeout: 5000,
      });
      expect(problems[0]).toContain("the identity key");
      await new Promise((settle) => setTimeout(settle, 1650));
      expect(store.keyAsks).toBe(2);
      expect(problems).toHaveLength(1);
    } finally {
      stop();
    }
  }, 15_000);

  it("reports a stored identity key that is not one once, and asks for it again only once the configuration changes", async () => {
    store.put(MACHINE_SCOPE, codex);
    store.key = "not a key";
    const { config } = configuration();
    await expect(config.refresh()).rejects.toThrow(
      expect.objectContaining({ code: "CONFIGURATION_UNREADABLE" })
    );
    const { problems, stop } = watched(config);
    try {
      await new Promise((settle) => setTimeout(settle, 1650));
      expect(store.keyAsks).toBe(1);
      expect(problems).toEqual([]);
      store.put(MACHINE_SCOPE, codex);
      await vi.waitFor(() => expect(problems).toHaveLength(1), {
        timeout: 5000,
      });
      expect(problems[0]).toContain("the identity key");
      await new Promise((settle) => setTimeout(settle, 1650));
      expect(store.keyAsks).toBe(2);
      expect(problems).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("loads a write that landed though its identity key could not be made", async () => {
    const { config, models } = configuration();
    await config.refresh();
    const { stop } = watched(config);
    try {
      store.refusing.key = [busy()];
      await expect(
        config.add({ id: "codex", plugin: "codex" }, { scope: "machine" })
      ).rejects.toThrow("locked");
      await vi.waitFor(() => expect(ids(models)).toEqual(["codex"]), {
        timeout: 5000,
      });
    } finally {
      stop();
    }
  });
});

describe("an edit after another host moved the entry", () => {
  it("applies to the scope that holds it now, and refuses one no scope holds", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    const a = configuration().config;
    const b = configuration().config;
    await loaded(a);
    await loaded(b);
    await b.replace([
      { enabled: true, id: "codex", plugin: "codex", scope: "workspace" },
    ]);
    await a.disable("codex");
    const kept = await store.read();
    expect(kept.machine?.providers).toEqual([]);
    expect(kept.workspace("ws1")?.providers).toEqual([
      { enabled: false, id: "codex", plugin: "codex" },
    ]);
    await b.remove("codex");
    await expect(a.enable("codex")).rejects.toThrow(
      '"codex" is not configured'
    );
    await expect(a.remove("codex")).rejects.toThrow(
      '"codex" is not configured'
    );
  });
});

describe("a write a newer read overtook", () => {
  it("loads what that read found, not the older configuration it wrote", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    const { config, models } = configuration();
    await loaded(config);
    let reading: Promise<void> | undefined;
    store.between = () => {
      store.between = undefined;
      store.put(MACHINE_SCOPE, {
        providers: [
          { enabled: true, id: "codex", plugin: "codex" },
          { enabled: true, id: "vercel", plugin: "vercel" },
        ],
      });
      reading = config.read();
    };
    await config.disable("codex");
    await reading;
    expect(ids(models)).toEqual(["codex", "vercel"]);
  });
});

describe("entries that cannot be built", () => {
  it("writes nothing when the edited entry's plugin throws, and later engines still load", async () => {
    const { config } = configuration();
    await config.add({ id: "codex", plugin: "codex" }, { scope: "machine" });
    const before = store.texts.get(MACHINE_SCOPE);
    for (const id of ["broken", "uncatalogued"]) {
      await expect(
        config.add({ id, plugin: id }, { scope: "machine" })
      ).rejects.toMatchObject({
        code: "PROVIDER_ENTRY_INVALID",
        message: expect.stringContaining("exploded"),
      });
    }
    expect(store.texts.get(MACHINE_SCOPE)).toBe(before);
    await expect(
      config.update("codex", { defaults: { text: "missing" } })
    ).rejects.toMatchObject({ code: "PROVIDER_ENTRY_INVALID" });
    expect(store.texts.get(MACHINE_SCOPE)).toBe(before);
    const fresh = configuration();
    await loaded(fresh.config);
    expect(fresh.config.list().map((entry) => entry.id)).toEqual(["codex"]);
  });

  it("keeps a stored entry whose plugin throws as unloadable, and loads the rest", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [
        { enabled: true, id: "broken", plugin: "broken" },
        { enabled: true, id: "uncatalogued", plugin: "uncatalogued" },
        { enabled: true, id: "codex", plugin: "codex" },
      ],
    });
    const { config, models } = configuration();
    await loaded(config);
    expect(ids(models)).toEqual(["codex"]);
    expect(
      config.list().map((entry) => [entry.id, entry.state, entry.problem])
    ).toEqual([
      ["codex", "ready", undefined],
      ["broken", "unloadable", expect.stringContaining("create exploded")],
      [
        "uncatalogued",
        "unloadable",
        expect.stringContaining("catalog exploded"),
      ],
    ]);
  });
});

it("never repeats a value a plugin's settings schema quotes", async () => {
  const strict = registered(
    plugin("strict", {
      detect: () => null,
      settings: z.object({
        key: z
          .string()
          .optional()
          .superRefine((value, context) => {
            context.addIssue({ code: "custom", message: `rejected ${value}` });
          }),
      }),
    })
  );
  store.put(MACHINE_SCOPE, {
    providers: [
      {
        enabled: true,
        id: "strict",
        plugin: "strict",
        settings: { key: "quoted-secret-value" },
      },
    ],
  });
  const config = new ProviderConfiguration({
    environment: {},
    models: new ModelManager(),
    plugins: [strict],
    store,
  });
  await loaded(config);
  const [entry] = config.list();
  expect(entry?.state).toBe("unloadable");
  expect(entry?.problem).toContain("key: custom");
  expect(JSON.stringify(config.list())).not.toContain("quoted-secret");
});

it("disables an entry that cannot load, and refuses to enable it again", async () => {
  store.put(MACHINE_SCOPE, {
    providers: [
      {
        enabled: true,
        id: "literal",
        plugin: "codex",
        settings: { key: "sk-LITERAL-SECRET-123" },
      },
      { enabled: true, id: "gone", plugin: "uninstalled" },
    ],
  });
  const { config } = configuration();
  await loaded(config);
  await config.disable("literal");
  await config.disable("gone");
  expect(config.list().map((entry) => [entry.id, entry.enabled])).toEqual([
    ["literal", false],
    ["gone", false],
  ]);
  await expect(config.enable("literal")).rejects.toMatchObject({
    code: "PROVIDER_ENTRY_INVALID",
  });
});

it("keeps a read-only engine's edits in memory and writes nothing", async () => {
  const models = new ModelManager();
  const config = new ProviderConfiguration({
    environment: { PATH: "/bin" },
    models,
    plugins: PLUGINS,
    readOnly: true,
    store,
    workspace: { dir: "/state/ws1", id: "ws1", root: "/repo" },
  });
  await config.add({ id: "codex", plugin: "codex" }, { scope: "machine" });
  await config.replace([
    { enabled: true, id: "codex", plugin: "codex", scope: "machine" },
    { enabled: true, id: "vercel", plugin: "vercel", scope: "workspace" },
  ]);
  expect(await config.initialize([])).toBe(false);
  expect(ids(models)).toEqual(["vercel", "codex"]);
  expect(store.texts.has(MACHINE_SCOPE)).toBe(false);
  expect(store.texts.has("ws1")).toBe(false);
  await config.read();
  expect(config.identityOf("codex")).toEqual(expect.any(String));
  expect(store.key).toBeUndefined();
});

it("lets a disabled entry stand beside an enabled one with its id, and refuses to enable it", async () => {
  store.put(MACHINE_SCOPE, {
    providers: [{ enabled: true, id: "codex", plugin: "codex" }],
  });
  store.put("ws1", {
    providers: [{ enabled: false, id: "codex", plugin: "codex" }],
  });
  const { config, models } = configuration();
  await loaded(config);
  expect(ids(models)).toEqual(["codex"]);
  expect(config.list().map((entry) => [entry.scope, entry.state])).toEqual([
    ["machine", "ready"],
    ["workspace", "excluded"],
  ]);
  await expect(config.enable("codex")).rejects.toMatchObject({
    code: "PROVIDER_ID_TAKEN",
  });
});

it("never lists a secret field's literal value", async () => {
  store.put(MACHINE_SCOPE, {
    providers: [
      {
        enabled: true,
        id: "named",
        plugin: "vercel",
        settings: { key: "VERCEL_KEY" },
      },
      {
        enabled: true,
        id: "literal",
        plugin: "codex",
        settings: { key: "sk-LITERAL-SECRET-123" },
      },
    ],
  });
  const { config } = configuration();
  await loaded(config);
  const listed = config.list();
  expect(JSON.stringify(listed)).not.toContain("sk-LITERAL");
  expect(listed.find((entry) => entry.id === "literal")).toMatchObject({
    settings: { key: "<redacted>" },
    state: "unloadable",
  });
  expect(listed.find((entry) => entry.id === "named")?.settings).toEqual({
    key: "$VERCEL_KEY",
  });
});

describe("replace", () => {
  it("refuses a machine id another workspace already configures, and a repeated id", async () => {
    store.put("ws2", {
      providers: [{ enabled: true, id: "shared", plugin: "codex" }],
    });
    const { config } = configuration();
    await expect(
      config.replace([
        { enabled: true, id: "shared", plugin: "codex", scope: "machine" },
      ])
    ).rejects.toMatchObject({ code: "PROVIDER_ID_TAKEN" });
    await expect(
      config.replace([
        { enabled: true, id: "codex", plugin: "codex", scope: "machine" },
        { enabled: true, id: "codex", plugin: "codex", scope: "workspace" },
      ])
    ).rejects.toMatchObject({ code: "PROVIDER_ID_TAKEN" });
    expect(configuration().config.configured).toBe(false);
  });

  it("writes neither file when an entry for either scope cannot be built", async () => {
    store.put("ws1", {
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    const before = store.texts.get("ws1") ?? "";
    const { config, models } = configuration();
    await loaded(config);
    await expect(
      config.replace([
        { enabled: true, id: "codex", plugin: "codex", scope: "machine" },
        { enabled: true, id: "broken", plugin: "broken", scope: "workspace" },
      ])
    ).rejects.toMatchObject({ code: "PROVIDER_ENTRY_INVALID" });
    const fresh = configuration().config;
    await fresh.read();
    expect(fresh.configured).toBe(true);
    expect(store.texts.get("ws1") ?? "").toBe(before);
    expect(store.texts.has(MACHINE_SCOPE)).toBe(false);
    await loaded(config);
    expect(ids(models)).toEqual(["codex"]);
  });

  it("replaces a workspace order with the entries' own order", async () => {
    store.put("ws1", {
      order: ["codex"],
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    const { config, models } = configuration();
    await config.replace([
      { enabled: true, id: "vercel", plugin: "vercel", scope: "workspace" },
      { enabled: true, id: "codex", plugin: "codex", scope: "machine" },
    ]);
    expect(JSON.parse(store.texts.get("ws1") ?? "")).not.toHaveProperty(
      "order"
    );
    expect(ids(models)).toEqual(["vercel", "codex"]);
  });

  it("moves this workspace's own id to the machine", async () => {
    const { config, models } = configuration();
    await config.add({ id: "codex", plugin: "codex" }, { scope: "workspace" });
    await config.replace([
      { enabled: true, id: "codex", plugin: "codex", scope: "machine" },
    ]);
    expect(ids(models)).toEqual(["codex"]);
    expect(config.list()[0]).toMatchObject({ id: "codex", scope: "machine" });
  });
});

it("gives the same entry another identity at another scope, and keeps it when only its place changes", async () => {
  store.put(MACHINE_SCOPE, {
    providers: [
      { enabled: true, id: "codex", plugin: "codex" },
      { enabled: true, id: "vercel", plugin: "vercel" },
    ],
  });
  const { config } = configuration();
  await loaded(config);
  const machine = config.identityOf("codex");
  store.put(MACHINE_SCOPE, {
    providers: [
      { enabled: true, id: "vercel", plugin: "vercel" },
      {
        defaults: { text: "codex-model" },
        enabled: true,
        id: "codex",
        plugin: "codex",
      },
    ],
  });
  await loaded(config);
  expect(config.identityOf("codex")).toBe(machine);
  store.put(MACHINE_SCOPE, { providers: [] });
  store.put("ws1", {
    providers: [{ enabled: true, id: "codex", plugin: "codex" }],
  });
  await loaded(config);
  expect(config.identityOf("codex")).toEqual(expect.any(String));
  expect(config.identityOf("codex")).not.toBe(machine);
});

describe("instance identity", () => {
  const FIRST_PARTY = [
    registered({
      ...claudeCodePlugin,
      list: () =>
        Promise.resolve([{ id: "test", kind: "text", modelId: "test" }]),
    }),
    registered({
      ...codexPlugin,
      list: () =>
        Promise.resolve([{ id: "test", kind: "text", modelId: "test" }]),
    }),
    registered(piPlugin),
  ];
  const identity = async (
    pluginId: string,
    environment: Record<string, string>,
    kept = store
  ) => {
    const env = { HOME: "/home/me", ...environment };
    if (pluginId === "pi") {
      matchProcessEnv(piPlugin.accountEnv ?? [], env);
    }
    const config = new ProviderConfiguration({
      environment: env,
      models: new ModelManager(),
      plugins: FIRST_PARTY,
      store: kept,
    });
    kept.put(MACHINE_SCOPE, {
      providers: [
        {
          enabled: true,
          id: "p",
          plugin: pluginId,
          settings: { binPath: "/bin/echo" },
        },
      ],
    });
    try {
      await config.refresh();
      return config.identityOf("p");
    } finally {
      await config.dispose();
    }
  };

  it("tells apart every account variable the first-party CLIs read, and agrees on the same environment", async () => {
    const cases: [string, Record<string, string>][] = [
      ["claude-code", {}],
      [
        "claude-code",
        { AWS_PROFILE: "personal", CLAUDE_CODE_USE_BEDROCK: "1" },
      ],
      ["claude-code", { AWS_PROFILE: "client", CLAUDE_CODE_USE_BEDROCK: "1" }],
      [
        "claude-code",
        { AWS_ACCESS_KEY_ID: "AKIACLIENT", CLAUDE_CODE_USE_BEDROCK: "1" },
      ],
      [
        "claude-code",
        { ANTHROPIC_VERTEX_PROJECT_ID: "a", CLAUDE_CODE_USE_VERTEX: "1" },
      ],
      [
        "claude-code",
        { ANTHROPIC_VERTEX_PROJECT_ID: "b", CLAUDE_CODE_USE_VERTEX: "1" },
      ],
      ["claude-code", { ANTHROPIC_API_KEY: "sk-personal" }],
      ["claude-code", { ANTHROPIC_API_KEY: "sk-client" }],
      ["claude-code", { CLAUDE_CONFIG_DIR: "/cfg/work" }],
      ["codex", { OPENAI_API_KEY: "k", OPENAI_ORG_ID: "a" }],
      ["codex", { OPENAI_API_KEY: "k", OPENAI_ORG_ID: "b" }],
      ["codex", { CODEX_HOME: "/codex/work" }],
      ["pi", { GROQ_API_KEY: "a" }],
      ["pi", { GROQ_API_KEY: "b" }],
      ["pi", { AWS_PROFILE: "client" }],
    ];
    const digests: (string | undefined)[] = [];
    for (const [name, machine] of cases) {
      digests.push(await identity(name, machine));
    }
    expect(new Set(digests).size).toBe(cases.length);
    expect(
      await identity("codex", { OPENAI_API_KEY: "k", OPENAI_ORG_ID: "a" })
    ).toBe(digests[9]);
    expect(
      await identity("codex", { CODEX_HOME: "/codex/work", EDITOR: "vi" })
    ).toBe(digests[11]);
  });

  it("keys identities to the machine, so a ref reveals nothing a guess could check", async () => {
    const here = await identity("claude-code", {
      ANTHROPIC_API_KEY: "sk-secret",
    });
    expect(
      await identity(
        "claude-code",
        { ANTHROPIC_API_KEY: "sk-secret" },
        new TestStore()
      )
    ).not.toBe(here);
    store.key = "not a key";
    await expect(identity("claude-code", {})).rejects.toThrow(
      expect.objectContaining({ code: "CONFIGURATION_UNREADABLE" })
    );
    expect(store.key).toBe("not a key");
  });

  it("makes the key once something is configured, and keeps it", async () => {
    const { config } = configuration();
    await config.read();
    expect(store.key).toBeUndefined();
    store.put(MACHINE_SCOPE, {
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    await loaded(config);
    const { key } = store;
    expect(key).toEqual(expect.any(String));
    const first = config.identityOf("codex");
    const again = configuration().config;
    await loaded(again);
    expect(store.key).toBe(key);
    expect(again.identityOf("codex")).toBe(first);
  });

  it("digests settings as the plugin parses them", async () => {
    const defaulted = registered({
      ...plugin("defaulted", { detect: () => null }),
      settings: z.object({ mode: z.string().default("fast") }),
    } as unknown as ProviderPlugin<{ mode: string }>);
    const of = async (settings: object) => {
      store.put(MACHINE_SCOPE, {
        providers: [{ enabled: true, id: "d", plugin: "defaulted", settings }],
      });
      const config = new ProviderConfiguration({
        environment: {},
        models: new ModelManager(),
        plugins: [defaulted],
        store,
      });
      await loaded(config);
      return config.identityOf("d");
    };
    expect(await of({})).toBe(await of({ mode: "fast" }));
    expect(await of({ mode: "slow" })).not.toBe(await of({}));
  });
});

it("refuses an entry with a host-supplied provider's id, and keeps its state when the manager refuses a set", async () => {
  const host = {
    available: true,
    id: "work",
    languageModel: () => ({}) as never,
    models: [{ id: "m", kind: "text", modelId: "m" }],
    offline: false,
  } as unknown as Provider;
  const models = new ModelManager();
  const config = new ProviderConfiguration({
    environment: {},
    fixed: [host],
    models,
    plugins: PLUGINS,
    store,
  });
  await loaded(config);
  const before = config.identityOf("work");
  await expect(
    config.add({ id: "work", plugin: "codex" }, { scope: "machine" })
  ).rejects.toMatchObject({ code: "PROVIDER_ID_TAKEN" });
  await config.add({ id: "codex", plugin: "codex" }, { scope: "machine" });
  const listed = config.list();
  const refuse = vi.spyOn(models, "setProviders").mockImplementation(() => {
    throw new Error("refused");
  });
  await expect(config.disable("codex")).rejects.toThrow("refused");
  refuse.mockRestore();
  expect(config.identityOf("work")).toBe(before);
  expect(config.list()).toEqual(listed);
  expect(config.instance("codex")).toBeDefined();
});

it("tells a configured instance with no execution from a host-supplied one", async () => {
  store.put(MACHINE_SCOPE, {
    providers: [{ enabled: true, id: "codex", plugin: "vercel" }],
  });
  const { config } = configuration();
  await loaded(config);
  expect(config.executionOf("codex")).toBeNull();
  const fixed = new ProviderConfiguration({
    environment: {},
    fixed: [],
    models: new ModelManager(),
    plugins: PLUGINS,
  });
  expect(fixed.executionOf("codex")).toBeUndefined();
});

it("builds stand-ins with the same id and catalog for a dry run", async () => {
  store.put(MACHINE_SCOPE, {
    providers: [{ enabled: true, id: "codex", plugin: "codex" }],
  });
  const echo = vi.fn((provider: Provider) => ({ ...provider, offline: false }));
  const { config, models } = configuration(undefined, { echo });
  await loaded(config);
  expect(echo).toHaveBeenCalledTimes(1);
  expect(models.providers[0]?.models.map((row) => row.id)).toEqual([
    "codex-model",
  ]);
});

it("proposes what each plugin detects, at the scope it would use", () => {
  const { config } = configuration();
  expect(config.propose().map((entry) => `${entry.id}@${entry.scope}`)).toEqual(
    ["codex@machine", "vercel@machine", "bedrock@workspace", "pi@machine"]
  );
});

describe("order", () => {
  it("places each provider once when a disabled entry repeats its id", async () => {
    store.put("ws1", {
      providers: [
        { enabled: true, id: "codex", plugin: "codex" },
        { enabled: true, id: "vercel", plugin: "vercel" },
      ],
    });
    store.put(MACHINE_SCOPE, {
      providers: [{ enabled: false, id: "codex", plugin: "codex" }],
    });
    const { config, models } = configuration();
    await loaded(config);
    expect(ids(models)).toEqual(["codex", "vercel"]);
  });
});

describe("instance ownership", () => {
  const built: Provider[] = [];
  const OWNED = [
    registered(
      plugin("codex", {
        create: (setup) => {
          const provider: Provider = {
            available: setup.settings.key !== "OFF",
            dispose: vi.fn(() => Promise.resolve()),
            id: setup.settings.key === "MISNAMED" ? "other" : setup.id,
            languageModel: () => ({}) as never,
            models: setup.models,
            offline: false,
          };
          built.push(provider);
          return { provider };
        },
      })
    ),
  ];

  beforeEach(() => {
    built.length = 0;
  });

  it("disposes an instance prepared for a write that is refused", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    store.put("ws1", {
      providers: [
        {
          enabled: false,
          id: "codex",
          plugin: "codex",
          settings: { key: "WORKSPACE" },
        },
      ],
    });
    const { config } = configuration(undefined, { plugins: OWNED });
    await loaded(config);
    await expect(config.enable("codex")).rejects.toThrow("already configured");
    expect(built).toHaveLength(2);
    expect(built[0]?.dispose).not.toHaveBeenCalled();
    expect(built[1]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes what the manager never took: an unavailable or misnamed instance, at reload and at dispose", async () => {
    const entryWith = (key: string) => ({
      providers: [
        { enabled: true, id: "codex", plugin: "codex", settings: { key } },
      ],
    });
    store.put(MACHINE_SCOPE, entryWith("OFF"));
    const { config, models } = configuration(undefined, { plugins: OWNED });
    await loaded(config);
    expect(ids(models)).toEqual([]);
    store.put(MACHINE_SCOPE, entryWith("MISNAMED"));
    await loaded(config);
    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(built[1]?.dispose).toHaveBeenCalledTimes(1);
    store.put(MACHINE_SCOPE, entryWith("OFF"));
    await loaded(config);
    store.put(MACHINE_SCOPE, entryWith("ON"));
    await loaded(config);
    expect(built[2]?.dispose).toHaveBeenCalledTimes(1);
    await config.dispose();
    expect(built[3]?.dispose).not.toHaveBeenCalled();
    store.put(MACHINE_SCOPE, entryWith("OFF"));
    await loaded(config);
    await config.dispose();
    expect(built[4]?.dispose).toHaveBeenCalledTimes(1);
  });

  const holdMachineLock = () => store.hold();
  const machineEntry = (key: string): ScopedRecord => ({
    enabled: true,
    id: "codex",
    plugin: "codex",
    scope: "machine",
    settings: { key },
  });

  it("keeps a waiting write's prepared instance when another write fails meanwhile", async () => {
    const { config, models } = configuration(undefined, { plugins: OWNED });
    const held = holdMachineLock();
    const replacing = config.replace([machineEntry("FIRST")]);
    await expect(
      config.initialize([{ enabled: true, id: "Bad Id", plugin: "codex" }])
    ).rejects.toThrow("not a valid provider id");
    held.release();
    await replacing;
    expect(built).toHaveLength(1);
    expect(built[0]?.dispose).not.toHaveBeenCalled();
    expect(models.providers[0]?.id).toBe("codex");
  });

  it("gives each overlapping write its own prepared instance, disposed at most once", async () => {
    const { config, models } = configuration(undefined, { plugins: OWNED });
    const held = holdMachineLock();
    const first = config.replace([machineEntry("FIRST")]);
    const second = config.replace([machineEntry("SECOND")]);
    held.release();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(built).toHaveLength(2);
    expect(config.list()[0]?.settings).toEqual({ key: "$SECOND" });
    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(built[1]?.dispose).not.toHaveBeenCalled();
    await models.dispose();
    expect(
      built.map((each) => vi.mocked(each.dispose)?.mock.calls.length)
    ).toEqual([1, 1]);
  });

  it("hands the real instance to the dry-run stand-in, which disposes it", async () => {
    store.put(MACHINE_SCOPE, {
      providers: [{ enabled: true, id: "codex", plugin: "codex" }],
    });
    const { config, models } = configuration(undefined, {
      echo: (real) => ({
        available: true,
        dispose: () => Promise.resolve(real.dispose?.()),
        id: real.id,
        languageModel: () => ({}) as never,
        models: real.models,
        offline: false,
      }),
      plugins: OWNED,
    });
    await loaded(config);
    await models.dispose();
    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("an instance that reads the process environment", () => {
  const ACCOUNT = "MARBLES_PROBE_ACCOUNT";
  const CALL = { prompt: [] } as never;

  it("supports frozen providers and class members with private state", async () => {
    class ProviderWithPrivateState {
      readonly #id = "private";
      readonly models: Provider["models"] = [];
      readonly offline = false;
      get available() {
        return this.#id === "private";
      }
      get id() {
        return this.#id;
      }
      async dispose() {
        if (this.#id !== "private") {
          throw new Error("wrong receiver");
        }
      }
      readonly languageModel: Provider["languageModel"] = () =>
        ({
          doGenerate: () => Promise.resolve("ran"),
          doStream: () => Promise.resolve("ran"),
          modelId: "model",
          provider: "private",
          specificationVersion: "v4",
          supportedUrls: {},
        }) as never;
    }
    const original = Object.freeze(new ProviderWithPrivateState());
    const view = refusingWhenChanged(original, [], {});
    expect(view.available).toBe(true);
    expect(view.id).toBe("private");
    await expect(view.languageModel("model").doGenerate(CALL)).resolves.toBe(
      "ran"
    );
    await expect(view.dispose?.()).resolves.toBeUndefined();
    expect(Object.keys(view)).toEqual(Object.keys(original));
  });
  const AMBIENT = [
    registered(
      plugin("pi", {
        accountEnv: [ACCOUNT],
        ambient: true,
        create: (setup) => ({
          provider: {
            available: true,
            id: setup.id,
            languageModel: () =>
              ({
                doGenerate: () => Promise.resolve("ran"),
                doStream: () => Promise.resolve("ran"),
                modelId: "pi-model",
                provider: "pi",
                specificationVersion: "v4",
                supportedUrls: {},
              }) as never,
            models: setup.models,
            offline: false,
          },
        }),
      })
    ),
  ];

  beforeEach(() => {
    store.put(MACHINE_SCOPE, {
      providers: [{ enabled: true, id: "pi", plugin: "pi" }],
    });
  });

  it("is unavailable when the host's environment names another account than the process holds", async () => {
    vi.stubEnv(ACCOUNT, "value-in-process");
    const { config, models } = configuration(
      { ...environmentSnapshot(), [ACCOUNT]: "value-of-host" },
      { plugins: AMBIENT }
    );
    await loaded(config);
    expect(ids(models)).toEqual([]);
    const [entry] = config.list();
    expect(entry?.state).toBe("unavailable");
    expect(entry?.problem).toContain(ACCOUNT);
    expect(entry?.problem).not.toContain("value-in-process");
    expect(entry?.problem).not.toContain("value-of-host");
  });

  it("refuses calls while the process account differs from the one it was configured with", async () => {
    vi.stubEnv(ACCOUNT, "first");
    const { config, models } = configuration(environmentSnapshot(), {
      plugins: AMBIENT,
    });
    await loaded(config);
    const model = models.resolve("text", "pi/pi-model").open();
    await expect(model.doGenerate(CALL)).resolves.toBe("ran");
    vi.stubEnv(ACCOUNT, "second");
    await expect(model.doGenerate(CALL)).rejects.toMatchObject({
      code: "PROVIDER_ENVIRONMENT_CHANGED",
    });
    await expect(model.doStream(CALL)).rejects.toMatchObject({
      code: "PROVIDER_ENVIRONMENT_CHANGED",
    });
    vi.stubEnv(ACCOUNT, "first");
    await expect(model.doGenerate(CALL)).resolves.toBe("ran");
  });
});

it("keeps Pi's configured default with a supplied catalog", async () => {
  const catalog = piPlugin.catalog({});
  const text = catalog.at(-1)?.id as string;
  const { provider } = piPlugin.create({
    defaults: { text },
    env: { PATH: "" },
    id: piPlugin.id,
    models: catalog,
    scope: "machine",
    settings: { binPath: "/bin/echo" },
  });
  try {
    expect(provider.defaults).toEqual({ text });
    const models = new ModelManager({ providers: [provider] });
    expect(models.resolve("text", { provider: piPlugin.id }).model).toBe(text);
  } finally {
    await provider.dispose?.();
  }
});
