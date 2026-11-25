import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Models } from "@foundry/models";
import { expect, it, vi } from "vitest";
import { initializeDatabase } from "~/database/open";
import { DatabaseProviderStore } from "~/database/providers";
import { stateDatabase } from "~/layout";
import { selectExecutor } from "~/lib/executor";
import { codex as codexPlugin } from "~/lib/providers/codex";
import { ProviderConfiguration } from "~/lib/providers/configuration";
import { fakeCodex } from "./helpers/codex";
import { homedCli } from "./helpers/homed-cli";
import { pluginOf } from "./helpers/plugins";

it("loads the configured Codex accounts independently and honors model defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-list-"));
  const db = await initializeDatabase(stateDatabase(root));
  const store = new DatabaseProviderStore({ database: db.database });
  const binPath = fakeCodex(root);
  const machineHome = join(root, "machine");
  const workspaceHome = join(root, "workspace");
  mkdirSync(machineHome);
  mkdirSync(workspaceHome);
  const listing = (home: string, rows: unknown) =>
    writeFileSync(join(home, "models.json"), JSON.stringify(rows));
  listing(machineHome, null);
  listing(workspaceHome, [
    { id: "workspace-preferred" },
    { id: "workspace-default", isDefault: true },
  ]);
  const provider = { enabled: true, plugin: "codex", settings: { binPath } };
  await store.update("ws", () => ({
    machine: { providers: [{ ...provider, id: "codex" }], version: 1 },
    workspace: {
      order: ["codex", "work"],
      providers: [
        {
          ...provider,
          defaults: { text: "workspace-preferred" },
          id: "work",
          settings: { binPath: homedCli(binPath, "CODEX_HOME", workspaceHome) },
        },
      ],
      version: 1,
    },
  }));
  const models = new Models();
  const config = new ProviderConfiguration({
    environment: { CODEX_HOME: machineHome, PATH: "" },
    models,
    plugins: [pluginOf(codexPlugin)],
    store,
    workspace: { dir: workspaceHome, id: "ws", root },
  });
  try {
    expect(models.available("codex/machine-default")).toBe(false);
    expect(await config.refresh()).toEqual([
      '"codex" has no models; its models could not be listed: Codex app-server could not list models',
    ]);
    expect(models.available("codex/gpt-5.5")).toBe(false);
    listing(machineHome, [
      { id: "gpt-5.5" },
      { id: "gpt-6.2-sol" },
      { id: "machine-default", isDefault: true },
    ]);
    expect(await config.refresh()).toEqual([]);
    expect(selectExecutor(models).model).toBe("machine-default");
    expect(models.available("codex/sol")).toBe(true);
    using held = models.resolve("text", "codex/sol");
    expect(held.open().modelId).toBe("gpt-6.2-sol");
    listing(machineHome, [
      { id: "gpt-6.10-sol" },
      { id: "gpt-6.2-sol" },
      { id: "machine-default", isDefault: true },
    ]);
    expect(await config.refresh()).toEqual([]);
    using newer = models.resolve("text", "codex/sol");
    expect(newer.open().modelId).toBe("gpt-6.10-sol");
    expect(held.open().modelId).toBe("gpt-6.2-sol");
    expect(selectExecutor(models).model).toBe("machine-default");
    expect(models.resolve("text", { provider: "work" }).model).toBe(
      "workspace-preferred"
    );
    expect(models.available("codex/workspace-default")).toBe(false);
    expect(models.available("work/workspace-default")).toBe(true);
    expect(models.available("work/machine-default")).toBe(false);

    listing(machineHome, null);
    expect(await config.refresh()).toEqual([
      '"codex" kept its last model list; its models could not be listed: Codex app-server could not list models',
    ]);
    expect(models.available("codex/machine-default")).toBe(true);

    listing(machineHome, []);
    expect(await config.refresh()).toEqual([]);
    expect(models.available("codex/machine-default")).toBe(false);
    expect(models.available("codex/sol")).toBe(false);
    expect(models.available("codex/gpt-5.5")).toBe(false);
    expect(config.list().find(({ id }) => id === "codex")?.state).toBe(
      "unavailable"
    );

    listing(workspaceHome, [{ id: "workspace-default", isDefault: true }]);
    expect(await config.refresh()).toEqual([]);
    expect(config.list().find(({ id }) => id === "work")).toMatchObject({
      problem:
        'the default text model "workspace-preferred" is not in the catalog',
      state: "unloadable",
    });
    expect(models.available("work/workspace-default")).toBe(false);
  } finally {
    await config.dispose();
    await models.dispose();
    db.close();
    rmSync(root, { force: true, recursive: true });
  }
});

it("uses the configured PATH for discovery when Codex is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-absent-"));
  fakeCodex(root);
  vi.stubEnv("PATH", root);
  try {
    const env = {};
    expect(codexPlugin.detect?.({ env })).toBeNull();
    const models = await codexPlugin.list?.({
      env,
      settings: {},
      signal: new AbortController().signal,
    });
    expect(models).toEqual([]);
    expect(
      codexPlugin.create({
        env,
        id: "codex",
        models: [],
        scope: "machine",
        settings: {},
      }).provider.available
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { force: true, recursive: true });
  }
});

it("stops the discovery app-server when an in-flight list is aborted", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-abort-"));
  const home = join(root, "account");
  mkdirSync(home);
  writeFileSync(join(home, "models.json"), JSON.stringify("hang"));
  const pidFile = join(home, "listing.pid");
  const controller = new AbortController();
  const reason = new Error("listing cancelled");
  const listing = codexPlugin.list?.({
    env: { CODEX_HOME: home },
    settings: { binPath: fakeCodex(root) },
    signal: controller.signal,
  });
  const settled = listing?.catch((error: unknown) => error);
  try {
    await expect
      .poll(
        () => existsSync(pidFile) && Number(readFileSync(pidFile, "utf8")) > 0
      )
      .toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort(reason);
    expect(await settled).toBe(reason);
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            return false;
          }
          throw error;
        }
      })
      .toBe(false);
  } finally {
    controller.abort();
    rmSync(root, { force: true, recursive: true });
  }
});
