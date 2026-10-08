import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EncryptionUnavailableError,
  type Encryptor,
  SecureStore,
} from "~/main/vault/secure-store";
import { JsonFileStore, MemoryStore } from "~/main/vault/store";

/** Reverses the string so a stored value is visibly not the plaintext. */
function reversingEncryptor(available = true): Encryptor {
  return {
    available: () => available,
    decrypt: (cipher) => {
      if (!cipher.startsWith("enc:")) {
        throw new Error("not ciphertext");
      }
      return [...cipher.slice(4)].reverse().join("");
    },
    encrypt: (plain) => `enc:${[...plain].reverse().join("")}`,
  };
}

describe("JsonFileStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "works-vault-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("reads back what it wrote, across instances", async () => {
    const file = path.join(dir, "nested", "settings.json");
    const first = new JsonFileStore(file);
    await first.set("claude:baseURL", "https://example.test");
    await first.set("gateway:baseURL", "http://localhost:4000");
    await first.delete("gateway:baseURL");

    const second = new JsonFileStore(file);
    expect(await second.get("claude:baseURL")).toBe("https://example.test");
    expect(await second.get("gateway:baseURL")).toBeNull();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "claude:baseURL": "https://example.test",
    });
  });

  it("treats a missing file as empty", async () => {
    const store = new JsonFileStore(path.join(dir, "absent.json"));
    expect(await store.get("anything")).toBeNull();
  });

  it("serialises overlapping writes", async () => {
    const file = path.join(dir, "settings.json");
    const store = new JsonFileStore(file);
    await Promise.all([store.set("a", "1"), store.set("b", "2")]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      a: "1",
      b: "2",
    });
  });

  it("does not persist a rejected save in a later write", async () => {
    const file = path.join(dir, "settings.json");
    const store = new JsonFileStore(file);
    await store.set("a", "original");
    await rm(file);
    await mkdir(file);

    await expect(store.set("a", "rejected")).rejects.toThrow();
    expect(await store.get("a")).toBe("original");

    await rm(file, { recursive: true });
    await store.set("b", "saved");
    const reopened = new JsonFileStore(file);
    expect(await reopened.get("a")).toBe("original");
    expect(await reopened.get("b")).toBe("saved");
  });

  it("preserves a value after a rejected delete and permits retry", async () => {
    const file = path.join(dir, "settings.json");
    const store = new JsonFileStore(file);
    await store.set("a", "original");
    await rm(file);
    await mkdir(file);

    await expect(store.delete("a")).rejects.toThrow();
    expect(await store.get("a")).toBe("original");

    await rm(file, { recursive: true });
    await store.set("b", "saved");
    expect(await new JsonFileStore(file).get("a")).toBe("original");
    await store.delete("a");
    expect(await new JsonFileStore(file).get("a")).toBeNull();
  });
});

describe("SecureStore", () => {
  it("stores ciphertext and returns plaintext", async () => {
    const backing = new MemoryStore();
    const store = new SecureStore(backing, reversingEncryptor());

    await store.set("claude:apiKey", "sk-ant-123");

    expect(await backing.get("claude:apiKey")).toBe("enc:321-tna-ks");
    expect(await store.get("claude:apiKey")).toBe("sk-ant-123");
  });

  it("reads a value that no longer decrypts as absent", async () => {
    const backing = new MemoryStore();
    await backing.set("claude:apiKey", "garbage");
    const store = new SecureStore(backing, reversingEncryptor());

    expect(await store.get("claude:apiKey")).toBeNull();
  });

  it("refuses to read or write without encryption", async () => {
    const store = new SecureStore(new MemoryStore(), reversingEncryptor(false));

    await expect(store.get("claude:apiKey")).rejects.toBeInstanceOf(
      EncryptionUnavailableError
    );
    await expect(store.set("claude:apiKey", "x")).rejects.toBeInstanceOf(
      EncryptionUnavailableError
    );
  });
});
