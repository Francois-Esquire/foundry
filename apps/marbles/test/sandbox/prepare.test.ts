import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { describe, expect, it, vi } from "vitest";
import { CLI_HARNESSES } from "~/lib/cli-harnesses";
import { guestAuth } from "~/lib/sandbox/credentials";
import { guestArtifact, prepareGuest } from "~/lib/sandbox/prepare";

describe("guest CLI preparation", () => {
  it("pins the SDK paired native binaries for both Linux architectures", () => {
    expect(guestArtifact("claude-code", "aarch64\n")).toMatchObject({
      executable: "/opt/foundry/bin/claude",
      files: [
        {
          executable: true,
          member: "package/claude",
          path: "/opt/foundry/bin/claude",
        },
      ],
      packageName: "@anthropic-ai/claude-agent-sdk-linux-arm64",
      version: "0.3.205",
    });
    const codex = guestArtifact("codex", "x86_64");
    expect(codex).toMatchObject({
      executable: "/opt/foundry/bin/codex",
      packageName: "@openai/codex",
      version: "0.144.6-linux-x64",
    });
    expect(codex.files).toContainEqual({
      executable: true,
      member: "package/vendor/x86_64-unknown-linux-musl/bin/codex",
      path: "/opt/foundry/bin/codex",
    });
    expect(codex.files).toContainEqual({
      executable: false,
      member: "package/vendor/x86_64-unknown-linux-musl/codex-package.json",
      path: "/opt/foundry/codex-package.json",
    });
    expect(guestArtifact("codex", "aarch64").files[0]?.member).toBe(
      "package/vendor/aarch64-unknown-linux-musl/bin/codex"
    );
    expect(() => guestArtifact("codex", "unknown")).toThrow(
      "Unsupported guest architecture"
    );
    expect(() => guestArtifact("codex", "constructor")).toThrow(
      "Unsupported guest architecture"
    );
  });

  it("installs before use, isolates writable state, and keeps keys out of persisted configuration", async () => {
    let installed = false;
    const runtime = createFakeContainerRuntime({
      exec: (command) => {
        if (command[0] === "uname") {
          return { exitCode: 0, stderr: "", stdout: "aarch64\n" };
        }
        if (command[0] === "chmod") {
          installed = true;
        }
        if (command[1] === "--version") {
          return {
            exitCode: installed ? 0 : 127,
            stderr: "",
            stdout: installed ? "2.1.205" : "",
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    const containers = createContainers({
      allowedMountRoots: [],
      instanceLabel: "prepare-test",
      runtime,
      store: createMemoryContainerStore(),
    });
    const container = await containers.start({
      format: "foundry.sandbox.container/1",
      image: "fixture",
    });
    try {
      const download = vi.fn(async () => ({
        "/opt/foundry/bin/claude": new Uint8Array([1, 2, 3]),
      }));
      const first = await prepareGuest(container, {
        auth: { apiKey: "key-first", kind: "apiKey" },
        download,
        harness: "claude-code",
        sessionId: "first",
        signal: new AbortController().signal,
      });
      const second = await prepareGuest(container, {
        auth: { apiKey: "key-second", kind: "apiKey" },
        download,
        harness: "claude-code",
        sessionId: "second",
        signal: new AbortController().signal,
      });
      expect(download).toHaveBeenCalledTimes(1);
      expect(first.environment.CLAUDE_CONFIG_DIR).not.toBe(
        second.environment.CLAUDE_CONFIG_DIR
      );
      expect(first.environment.ANTHROPIC_API_KEY).toBe("key-first");
      expect(second.environment.ANTHROPIC_API_KEY).toBe("key-second");
      expect(JSON.stringify(container.row)).not.toContain("key-first");
      expect(
        JSON.stringify([...(runtime.instances[0]?.files ?? [])])
      ).not.toContain("key-first");
      expect(first.environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      await containers.shutdown();
    }
  });
});

describe("guest environments", () => {
  it("sends each harness only its own credential", () => {
    expect(
      CLI_HARNESSES["claude-code"].env("/state", {
        kind: "oauth",
        token: "subscription",
      })
    ).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      CLAUDE_CONFIG_DIR: "/state/claude",
    });
    expect(
      CLI_HARNESSES.codex.env("/state", { apiKey: "key", kind: "apiKey" })
    ).toEqual({ CODEX_HOME: "/state/codex", OPENAI_API_KEY: "key" });
    // Subscription tokens reach Codex over the app-server, never the environment.
    expect(
      CLI_HARNESSES.codex.env("/state", {
        kind: "chatgpt",
        tokens: { accessToken: "token", chatgptAccountId: "account" },
      })
    ).toEqual({ CODEX_HOME: "/state/codex" });
  });
});

describe("guest authentication", () => {
  it("prefers the session's key and refuses a blank credential", async () => {
    await expect(
      guestAuth("codex", { apiKey: "key", oauthToken: "ignored" })
    ).resolves.toEqual({ apiKey: "key", kind: "apiKey" });
    await expect(guestAuth("claude-code", { apiKey: "  " })).rejects.toThrow(
      "claude-code requires explicit per-session authentication"
    );
    await expect(
      guestAuth("claude-code", { oauthToken: "explicit" })
    ).resolves.toEqual({ kind: "oauth", token: "explicit" });
    await expect(guestAuth("claude-code", { oauthToken: " " })).rejects.toThrow(
      "explicit per-session authentication"
    );
    await expect(guestAuth("codex", { apiKey: "\t " })).rejects.toThrow(
      "codex requires explicit per-session authentication"
    );
  });

  it("falls through to the host's subscription login for an empty key", async () => {
    const tokens = { accessToken: "access", chatgptAccountId: "account" };
    const logins = {
      "claude-code": vi.fn(async (oauthToken?: string) => ({
        kind: "oauth" as const,
        token: oauthToken ?? "keychain",
      })),
      codex: vi.fn(async () => ({ kind: "chatgpt" as const, tokens })),
    };
    await expect(guestAuth("codex", { apiKey: "" }, logins)).resolves.toEqual({
      kind: "chatgpt",
      tokens,
    });
    await expect(
      guestAuth("claude-code", { apiKey: "", oauthToken: "explicit" }, logins)
    ).resolves.toEqual({ kind: "oauth", token: "explicit" });
    await guestAuth("codex", { apiKey: "key" }, logins);
    expect(logins.codex).toHaveBeenCalledOnce();
  });
});
