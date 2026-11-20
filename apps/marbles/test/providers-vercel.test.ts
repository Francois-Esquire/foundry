import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelManager } from "@foundry/models";
import { expect, it, vi } from "vitest";
import { initializeDatabase } from "~/database/open";
import { DatabaseProviderStore } from "~/database/providers";
import { stateDatabase } from "~/layout";
import { ProviderConfiguration } from "~/lib/providers/configuration";
import { registered, vercelPlugin } from "~/lib/providers/plugins";

it("refreshes scoped Vercel catalogs and resolves the listed models and defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "vercel-list-"));
  const database = await initializeDatabase(stateDatabase(root));
  const store = new DatabaseProviderStore({ database: database.database });
  const models = new ModelManager();
  const machine = "https://machine.example/v1";
  const workspace = "https://workspace.example/v1";
  const configuration = new ProviderConfiguration({
    environment: {
      machine: { VERCEL_KEY: "machine-test-key" },
      workspace: { VERCEL_KEY: "workspace-test-key" },
    },
    models,
    plugins: [registered(vercelPlugin)],
    store,
    workspace: { dir: root, id: "ws", root },
  });
  const entry = (id: string, baseURL: string) => ({
    enabled: true,
    id,
    plugin: "vercel",
    settings: { apiKey: "VERCEL_KEY", baseURL },
  });
  let machineRows = [
    { id: "vendor/first", type: "language" },
    { id: "openai/gpt-5.6-luna", type: "language" },
    { id: "vendor/embed", type: "embedding" },
  ];
  let machineFails = false;
  const fetch = vi.fn((url: string) => {
    if (url === `${machine}/models`) {
      return Promise.resolve(
        machineFails
          ? new Response(null, { status: 503 })
          : Response.json({ data: machineRows })
      );
    }
    expect(url).toBe(`${workspace}/models`);
    return Promise.resolve(
      Response.json({
        data: [
          { id: "vendor/workspace-first", type: "language" },
          { id: "vendor/workspace-preferred", type: "language" },
        ],
      })
    );
  });
  vi.stubGlobal("fetch", fetch);
  try {
    await store.update("ws", () => ({
      machine: { providers: [entry("vercel", machine)], version: 1 },
      workspace: {
        order: ["vercel", "work"],
        providers: [
          {
            ...entry("work", workspace),
            defaults: { text: "vendor/workspace-preferred" },
          },
        ],
        version: 1,
      },
    }));
    await configuration.read();
    configuration.load();
    expect(models.available("vercel/openai/gpt-5.6-luna")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();

    expect(await configuration.refresh()).toEqual([]);
    expect(fetch).toHaveBeenCalledWith(`${machine}/models`, {
      headers: { Authorization: "Bearer machine-test-key" },
      signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenCalledWith(`${workspace}/models`, {
      headers: { Authorization: "Bearer workspace-test-key" },
      signal: expect.any(AbortSignal),
    });
    expect(models.resolve("text").model).toBe("vendor/first");
    expect(models.resolve("text", { provider: "work" }).model).toBe(
      "vendor/workspace-preferred"
    );
    expect(models.available("vercel/vendor/embed")).toBe(true);
    expect(models.available("work/vendor/embed")).toBe(false);

    machineRows = [{ id: "vendor/replacement", type: "language" }];
    expect(await configuration.refresh()).toEqual([]);
    expect(models.available("vercel/vendor/first")).toBe(false);
    expect(models.available("vercel/openai/gpt-5.6-luna")).toBe(false);
    expect(models.resolve("text").model).toBe("vendor/replacement");

    machineFails = true;
    expect(await configuration.refresh()).toEqual([
      '"vercel" kept its last model list; its models could not be listed: GET /models answered 503',
    ]);
    expect(models.resolve("text").model).toBe("vendor/replacement");
  } finally {
    await configuration.dispose();
    await models.dispose();
    vi.unstubAllGlobals();
    database.close();
    rmSync(root, { force: true, recursive: true });
  }
});
