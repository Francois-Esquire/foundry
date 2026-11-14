import { MODULE_SOURCE_LIMITS } from "@foundry/modules/source";
import { expect, it } from "vitest";
import { fakeClient, openFakeVault } from "../helpers/fake-api";

it("applies the same admission at the save boundary", async () => {
  const client = fakeClient(await openFakeVault());
  await expect(
    client.modules.saveSource({
      expected: {
        artifactId: "a",
        contentId: "c",
        updatedAt: new Date().toISOString(),
      },
      id: "m",
      source: { "../escape.ts": "" },
    })
  ).rejects.toThrow();
  await expect(
    client.modules.saveSource({
      expected: {
        artifactId: "a",
        contentId: "c",
        updatedAt: new Date().toISOString(),
      },
      id: "m",
      source: { big: "x".repeat(MODULE_SOURCE_LIMITS.maxFileCodeUnits + 1) },
    })
  ).rejects.toThrow();
});
