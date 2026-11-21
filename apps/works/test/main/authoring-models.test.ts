import { ModelManager } from "@foundry.sh/marbles/engine";
import { expect, it } from "vitest";
import { vaultAuthoringModels } from "~/main/modules/authoring/models";
import { openFakeVault } from "../helpers/fake-api";

it("routes turns to the first provider the vault holds a key for, read at each turn", async () => {
  const vault = await openFakeVault();
  const models = new ModelManager();
  const authoring = vaultAuthoringModels(models, vault);
  expect(() => authoring.route()).toThrow("Add a Gateway or Vercel API key");
  await vault.set("vercel", "apiKey", "vck_test");
  expect(authoring.route()).toMatchObject({ provider: "vercel" });
  await vault.set("gateway", "apiKey", "sk-test");
  expect(authoring.route()).toMatchObject({ provider: "gateway" });
  await vault.set("gateway", "apiKey", null);
  await vault.set("vercel", "apiKey", null);
  expect(() => authoring.route()).toThrow("Add a Gateway or Vercel API key");
});

it("retains unchanged provider instances and replaces only rotated credentials", async () => {
  const vault = await openFakeVault();
  await vault.set("gateway", "apiKey", "sk-first");
  await vault.set("vercel", "apiKey", "vck-first");
  const models = new ModelManager();
  const routes = vaultAuthoringModels(models, vault);
  expect(routes.route().provider).toBe("gateway");
  const [gateway, vercel] = models.providers;
  routes.route();
  expect(models.providers[0]).toBe(gateway);
  expect(models.providers[1]).toBe(vercel);
  await vault.set("gateway", "apiKey", "sk-rotated");
  routes.route();
  expect(models.providers[0]).not.toBe(gateway);
  expect(models.providers[1]).toBe(vercel);
  await vault.set("gateway", "apiKey", null);
  expect(routes.route().provider).toBe("vercel");
  await models.dispose();
});
