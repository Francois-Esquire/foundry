import { describe, expect, it, vi } from "vitest";
import { EncryptionUnavailableError } from "~/main/vault/secure-store";
import { type KeyValueStore, MemoryStore } from "~/main/vault/store";
import { Vault } from "~/main/vault/vault";

function stores() {
  return { secure: new MemoryStore(), settings: new MemoryStore() };
}

describe("Vault", () => {
  it("reports every registered field, unset by default", async () => {
    const vault = await Vault.open(stores(), { env: {} });
    const status = vault.status();

    expect(status.encryption).toBe("available");
    expect(status.fields.claude.apiKey).toEqual({
      isSet: false,
      source: "none",
    });
    expect(status.fields.googleStitch.apiKey?.source).toBe("none");
    // The gateway URL always resolves: it has a localhost fallback.
    expect(status.fields.gateway.baseURL).toEqual({
      isSet: true,
      source: "default",
    });
    expect(vault.resolve("gateway", "baseURL")).toBe("http://localhost:4000");
  });

  it("falls back to the environment and reports it", async () => {
    const vault = await Vault.open(stores(), {
      env: { ANTHROPIC_API_KEY: " sk-env ", FAL_KEY: "   " },
    });

    expect(vault.status().fields.claude.apiKey?.source).toBe("env");
    expect(vault.resolve("claude", "apiKey")).toBe("sk-env");
    expect(vault.status().fields.fal.apiKey?.source).toBe("none");
  });

  it("writes each field to its tier and prefers the stored value", async () => {
    const tiers = stores();
    const vault = await Vault.open(tiers, {
      env: { ANTHROPIC_API_KEY: "sk-env" },
    });
    const listener = vi.fn();
    vault.onChange(listener);

    await vault.set("claude", "apiKey", "  sk-stored ");
    await vault.set("claude", "baseURL", "https://proxy.test");

    expect(await tiers.secure.get("claude:apiKey")).toBe("sk-stored");
    expect(await tiers.settings.get("claude:baseURL")).toBe(
      "https://proxy.test"
    );
    expect(await tiers.settings.get("claude:apiKey")).toBeNull();
    expect(vault.resolve("claude", "apiKey")).toBe("sk-stored");
    expect(vault.status().fields.claude.apiKey?.source).toBe("store");
    expect(listener).toHaveBeenCalledTimes(2);

    const reopened = await Vault.open(tiers, { env: {} });
    expect(reopened.status().fields.claude.baseURL?.source).toBe("store");
  });

  it("clears on null or blank and falls back again", async () => {
    const tiers = stores();
    const vault = await Vault.open(tiers, { env: { FAL_KEY: "fal-env" } });
    await vault.set("fal", "apiKey", "fal-stored");

    await vault.set("fal", "apiKey", "   ");

    expect(await tiers.secure.get("fal:apiKey")).toBeNull();
    expect(vault.status().fields.fal.apiKey?.source).toBe("env");
    expect(vault.resolve("fal", "apiKey")).toBe("fal-env");
  });

  it("does not notify when nothing changed", async () => {
    const vault = await Vault.open(stores(), { env: {} });
    const listener = vi.fn();
    vault.onChange(listener);

    await vault.set("fal", "apiKey", null);
    await vault.set("fal", "apiKey", "k");
    await vault.set("fal", "apiKey", "k");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("applies overlapping saves and clears in request order", async () => {
    const tiers = stores();
    const vault = await Vault.open(tiers, { env: {} });
    const sources: string[] = [];
    vault.onChange((status) => {
      sources.push(status.fields.fal.apiKey?.source ?? "none");
    });

    await Promise.all([
      vault.set("fal", "apiKey", "first"),
      vault.set("fal", "apiKey", null),
      vault.set("fal", "apiKey", "last"),
    ]);

    expect(sources).toEqual(["store", "none", "store"]);
    expect(vault.resolve("fal", "apiKey")).toBe("last");
    expect(await tiers.secure.get("fal:apiKey")).toBe("last");
    expect(
      (await Vault.open(tiers, { env: {} })).resolve("fal", "apiKey")
    ).toBe("last");
  });

  it("saves the current value again after an overlapping clear", async () => {
    const tiers = stores();
    const vault = await Vault.open(tiers, { env: {} });
    await vault.set("fal", "apiKey", "original");

    await Promise.all([
      vault.set("fal", "apiKey", null),
      vault.set("fal", "apiKey", "original"),
    ]);

    expect(vault.resolve("fal", "apiKey")).toBe("original");
    expect(await tiers.secure.get("fal:apiKey")).toBe("original");
  });

  it("continues queued mutations after a rejected write", async () => {
    const tiers = stores();
    const vault = await Vault.open(tiers, { env: {} });
    const listener = vi.fn();
    vault.onChange(listener);
    vi.spyOn(tiers.secure, "set").mockRejectedValueOnce(new Error("disk full"));

    const results = await Promise.allSettled([
      vault.set("fal", "apiKey", "rejected"),
      vault.set("fal", "apiKey", "saved"),
    ]);

    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toEqual({ status: "fulfilled", value: undefined });
    expect(vault.resolve("fal", "apiKey")).toBe("saved");
    expect(await tiers.secure.get("fal:apiKey")).toBe("saved");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects fields that are not in the registry", async () => {
    const vault = await Vault.open(stores(), { env: {} });

    await expect(vault.set("fal", "baseURL", "x")).rejects.toThrow(
      "Unknown vault field fal.baseURL"
    );
    expect(vault.resolve("fal", "baseURL")).toBeNull();
  });

  it("keeps a failed write out of memory", async () => {
    const failing: KeyValueStore = {
      delete: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error("disk full")),
    };
    const vault = await Vault.open(
      { secure: failing, settings: new MemoryStore() },
      { env: {} }
    );

    await expect(vault.set("fal", "apiKey", "k")).rejects.toThrow("disk full");
    expect(vault.status().fields.fal.apiKey?.isSet).toBe(false);
  });

  it("opens without encryption and says so", async () => {
    const unavailable: KeyValueStore = {
      delete: () => Promise.resolve(),
      get: () => Promise.reject(new EncryptionUnavailableError()),
      set: () => Promise.reject(new EncryptionUnavailableError()),
    };
    const vault = await Vault.open(
      { secure: unavailable, settings: new MemoryStore() },
      { env: { ANTHROPIC_API_KEY: "sk-env" } }
    );

    const status = vault.status();
    expect(status.encryption).toBe("unavailable");
    expect(status.fields.claude.apiKey?.source).toBe("env");
    expect(status.fields.fal.apiKey?.source).toBe("none");

    // A plain-tier write must not claim encryption came back.
    await vault.set("gateway", "baseURL", "http://proxy.test");
    expect(vault.status().encryption).toBe("unavailable");
    await expect(vault.set("fal", "apiKey", "k")).rejects.toBeInstanceOf(
      EncryptionUnavailableError
    );
  });
});
