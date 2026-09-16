import { describe, expect, test, vi } from "vitest";

import type { CredentialsChange } from "../config/credentials";

import { Credentials } from "../config/credentials";

declare module "../config/credentials" {
  interface CredentialsVault {
    anthropicApiKey?: string | null;
    githubToken?: string | null;
  }
}

describe("Credentials", () => {
  test("get() returns initial bag", () => {
    const creds = new Credentials({ anthropicApiKey: "sk-init" });
    expect(creds.get()).toEqual({ anthropicApiKey: "sk-init" });
  });

  test("set() shallow-merges and emits 'changed'", () => {
    const creds = new Credentials();
    const seen: CredentialsChange[] = [];
    creds.on("changed", (p: CredentialsChange) => seen.push(p));

    creds.set({ anthropicApiKey: "sk-1" });
    creds.set({ githubToken: "ghp-1" });

    expect(creds.get()).toEqual({
      anthropicApiKey: "sk-1",
      githubToken: "ghp-1",
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.before).toEqual({ anthropicApiKey: "sk-1" });
    expect(seen[1]?.after).toEqual({
      anthropicApiKey: "sk-1",
      githubToken: "ghp-1",
    });
  });

  test("set() with null clears that key, undefined leaves it alone", () => {
    const creds = new Credentials({
      anthropicApiKey: "sk-1",
      githubToken: "ghp-1",
    });

    creds.set({ anthropicApiKey: null, githubToken: undefined });

    expect(creds.get()).toEqual({ githubToken: "ghp-1" });
  });

  test("clear() empties the bag and emits once", () => {
    const creds = new Credentials({ anthropicApiKey: "sk-1" });
    const handler = vi.fn();
    creds.on("changed", handler);

    creds.clear();

    expect(creds.get()).toEqual({});
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
