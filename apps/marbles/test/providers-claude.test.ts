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
import {
  configureSpawnRecovery,
  recordPath,
} from "@foundry/lib/node/spawn-record";
import { Models } from "@foundry/models";
import { expect, it, vi } from "vitest";
import { initializeDatabase } from "~/database/open";
import { DatabaseProviderStore } from "~/database/providers";
import { stateDatabase } from "~/layout";
import { selectExecutor } from "~/lib/executor";
import { claudeCode as claudeCodePlugin } from "~/lib/providers/claude-code";
import { ProviderConfiguration } from "~/lib/providers/configuration";
import { fakeClaude } from "./helpers/claude";
import { homedCli } from "./helpers/homed-cli";
import { pluginOf } from "./helpers/plugins";

it("loads scoped Claude Code catalogs and uses the reported or configured default", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-list-"));
  const database = await initializeDatabase(stateDatabase(root));
  const store = new DatabaseProviderStore({ database: database.database });
  const models = new Models();
  const machine = join(root, "machine");
  const workspace = join(root, "workspace");
  mkdirSync(machine);
  mkdirSync(workspace);
  const listing = (home: string, rows: unknown) =>
    writeFileSync(join(home, "models.json"), JSON.stringify(rows));
  listing(machine, [
    { value: "opus" },
    { resolvedModel: "claude-sonnet-5", value: "sonnet" },
    { resolvedModel: "claude-opus-5-5", value: "default" },
  ]);
  listing(workspace, [
    { value: "default" },
    { resolvedModel: "claude-sonnet-5", value: "sonnet[1m]" },
  ]);
  const configuration = new ProviderConfiguration({
    environment: { CLAUDE_CONFIG_DIR: machine },
    models,
    plugins: [pluginOf(claudeCodePlugin)],
    store,
    workspace: { dir: root, id: "ws", root },
  });
  vi.stubEnv("ANTHROPIC_API_KEY", "ambient-test-key");
  try {
    const binPath = fakeClaude(root);
    const entry = {
      enabled: true,
      plugin: "claude-code",
      settings: { binPath },
    };
    await store.update("ws", () => ({
      machine: { providers: [{ ...entry, id: "claude-code" }], version: 1 },
      workspace: {
        order: ["claude-code", "work"],
        providers: [
          {
            ...entry,
            defaults: { text: "sonnet[1m]" },
            id: "work",
            settings: {
              binPath: homedCli(binPath, "CLAUDE_CONFIG_DIR", workspace),
            },
          },
        ],
        version: 1,
      },
    }));
    await configuration.read();
    configuration.load();
    expect(models.available("claude-code/opus")).toBe(false);

    expect(await configuration.refresh()).toEqual([]);
    expect(selectExecutor(models).model).toBe("default");
    expect(models.available("claude-code/claude-opus-5-5")).toBe(true);
    expect(models.available("claude-code/sonnet")).toBe(true);
    expect(
      models.resolve("text", "claude-code/sonnet").definition.modelId
    ).toBe("sonnet");
    expect(
      models.resolve("text", "claude-code/claude-sonnet-5").definition.modelId
    ).toBe("claude-sonnet-5");
    expect(models.available("work/sonnet")).toBe(false);
    expect(models.available("claude-code/sonnet[1m]")).toBe(false);
    expect(models.available("work/claude-opus-5-5")).toBe(false);
    expect(models.available("work/claude-sonnet-5")).toBe(true);
    expect(models.resolve("text", { provider: "work" }).model).toBe(
      "sonnet[1m]"
    );

    listing(machine, [{ value: "haiku" }, { value: "opus" }]);
    expect(await configuration.refresh()).toEqual([]);
    expect(selectExecutor(models).model).toBe("haiku");
    expect(models.available("claude-code/default")).toBe(false);
    listing(machine, null);
    expect(await configuration.refresh()).toEqual([
      '"claude-code" kept its last model list; its models could not be listed: Claude Code SDK could not list models',
    ]);
    expect(selectExecutor(models).model).toBe("haiku");
    listing(machine, []);
    expect(await configuration.refresh()).toEqual([]);
    expect(models.available("claude-code/haiku")).toBe(false);
    expect(existsSync(join(machine, "unexpected-request"))).toBe(false);
    expect(existsSync(join(workspace, "unexpected-request"))).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    await configuration.dispose();
    await models.dispose();
    database.close();
    rmSync(root, { force: true, recursive: true });
  }
});

it("records the owned Claude Code listing process and stops it when aborted", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-abort-"));
  const home = join(root, "account");
  const records = join(root, "records");
  mkdirSync(home);
  mkdirSync(records, { mode: 0o700 });
  configureSpawnRecovery(records);
  writeFileSync(join(home, "models.json"), JSON.stringify("hang"));
  const pidFile = join(home, "listing.pid");
  const controller = new AbortController();
  const reason = new Error("listing cancelled");
  const listing = claudeCodePlugin.list?.({
    env: { CLAUDE_CONFIG_DIR: home },
    settings: { binPath: fakeClaude(root) },
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
    const record = recordPath(records, pid);
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({
      group: true,
      pid,
    });
    controller.abort(reason);
    expect(await settled).toBe(reason);
    await expect.poll(() => existsSync(record)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    configureSpawnRecovery(undefined);
    rmSync(root, { force: true, recursive: true });
  }
});
