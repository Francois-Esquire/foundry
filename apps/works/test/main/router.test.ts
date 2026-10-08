import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { fakeClient, openFakeVault } from "../helpers/fake-api";

describe("vault router", () => {
  it("round-trips a credential through status, set, and clear", async () => {
    const vault = await openFakeVault({ env: { FAL_KEY: "fal-env" } });
    const client = fakeClient(vault);

    const falSource = async () =>
      (await client.vault.status()).fields.fal.apiKey?.source;

    expect(await falSource()).toBe("env");

    await client.vault.set({ key: "apiKey", owner: "fal", value: "fal-123" });
    expect(await falSource()).toBe("store");
    expect(vault.resolve("fal", "apiKey")).toBe("fal-123");

    await client.vault.clear({ key: "apiKey", owner: "fal" });
    expect(await falSource()).toBe("env");
  });

  it("never returns a value in status", async () => {
    const vault = await openFakeVault();
    const client = fakeClient(vault);
    await client.vault.set({ key: "apiKey", owner: "claude", value: "sk-x" });

    expect(JSON.stringify(await client.vault.status())).not.toContain("sk-x");
  });

  it("rejects an owner outside the registry with input validation", async () => {
    const client = fakeClient(await openFakeVault());

    await expect(
      // @ts-expect-error the owner enum is the registry
      client.vault.set({ key: "apiKey", owner: "openai", value: "x" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a field the owner does not have", async () => {
    const client = fakeClient(await openFakeVault());

    const error = await client.vault
      .set({ key: "baseURL", owner: "fal", value: "https://x.test" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: "fal has no field named baseURL",
    });
  });
});
