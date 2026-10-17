import {
  gatewayBinding,
  ModelManager,
  vercelBinding,
} from "@foundry.sh/marbles/engine";
import { expect, it } from "vitest";
import { vaultAuthoringModels } from "~/main/modules/authoring/models";
import { openFakeVault } from "../helpers/fake-api";

it("routes turns to the first provider the vault holds a key for, read at each turn", async () => {
  const vault = await openFakeVault();
  const models = new ModelManager({
    bindings: [gatewayBinding, vercelBinding],
  });
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
