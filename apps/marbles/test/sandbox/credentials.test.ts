import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  claudeLoginLocation,
  claudeSubscriptionToken,
  guestAuth,
  piCredential,
} from "~/lib/sandbox/credentials";

it("selects the active subscription access token without returning refresh credentials", async () => {
  const readCredentials = vi.fn();
  const token = await claudeSubscriptionToken({
    platform: "darwin",
    readCredentials,
    readKeychain: async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "active-access",
          expiresAt: Date.now() + 3_600_000,
          refreshToken: "host-only-refresh",
        },
      }),
  });
  expect(token).toBe("active-access");
  expect(readCredentials).not.toHaveBeenCalled();
});

it("rejects an expired subscription with a login remedy and no secret in the error", async () => {
  await expect(
    claudeSubscriptionToken({
      platform: "linux",
      readCredentials: async () =>
        JSON.stringify({
          claudeAiOauth: { accessToken: "expired-secret", expiresAt: 1 },
        }),
    })
  ).rejects.toThrow("Sign in with Claude Code on the host");
});

it("accepts an explicitly supplied subscription token without reading host credentials", async () => {
  const readKeychain = vi.fn();
  expect(
    await claudeSubscriptionToken({
      oauthToken: "setup-token",
      platform: "darwin",
      readKeychain,
    })
  ).toBe("setup-token");
  expect(readKeychain).not.toHaveBeenCalled();
});

it("resolves the selected Pi model credential on the host", async () => {
  const readKey = vi.fn(async () => "  current-key\n");
  expect(await piCredential("openai/gpt-5", readKey)).toBe("current-key");
  expect(readKey).toHaveBeenCalledWith("openai/gpt-5");
});

it("rejects blank Pi credentials and redacts CLI failures", async () => {
  await expect(piCredential(undefined, async () => "  ")).rejects.toThrow(
    "Pi login is unavailable"
  );
  const failure = piCredential(undefined, async () => {
    throw new Error("private-key-in-cli-output");
  });
  await expect(failure).rejects.toThrow("Pi login is unavailable");
  await expect(failure).rejects.not.toThrow("private-key-in-cli-output");
});

it("takes a guest's Claude login from the provider instance's environment, never the host process's", async () => {
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "host-process-token";
  try {
    await expect(
      guestAuth("claude-code", {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "instance-token" },
      })
    ).resolves.toEqual({ kind: "oauth", token: "instance-token" });
    await expect(
      claudeSubscriptionToken({
        readCredentials: () => Promise.reject(new Error("no file")),
        readKeychain: () => Promise.reject(new Error("no keychain")),
      })
    ).rejects.toThrow();
  } finally {
    if (saved === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    }
  }
});

it("takes a guest's Codex login from the instance's CODEX_HOME, else its HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-codex-login-"));
  const login = (dir: string, token: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        tokens: { access_token: token, account_id: "acct", refresh_token: "r" },
      })
    );
  };
  try {
    login(join(root, "work"), "work-token");
    login(join(root, "home", ".codex"), "home-token");
    await expect(
      guestAuth("codex", { env: { CODEX_HOME: join(root, "work") } })
    ).resolves.toMatchObject({ tokens: { accessToken: "work-token" } });
    await expect(
      guestAuth("codex", { env: { HOME: join(root, "home") } })
    ).resolves.toMatchObject({ tokens: { accessToken: "home-token" } });
    await expect(
      guestAuth("codex", { env: { CODEX_HOME: join(root, "missing") } })
    ).rejects.toThrow("Codex subscription login is unavailable");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("reads the Claude Code login the instance's own CLI uses, never another", async () => {
  const host = { home: "/home/me", user: "me" };
  expect(claudeLoginLocation({}, host)).toEqual({
    account: "me",
    file: "/home/me/.claude/.credentials.json",
    service: "Claude Code-credentials",
  });
  expect(claudeLoginLocation({ HOME: "/home/work", USER: "w" }, host)).toEqual({
    account: "w",
    file: "/home/work/.claude/.credentials.json",
    service: "Claude Code-credentials",
  });
  expect(claudeLoginLocation({ CLAUDE_CONFIG_DIR: "/cfg/work" }, host)).toEqual(
    {
      account: "me",
      file: "/cfg/work/.credentials.json",
      service: "Claude Code-credentials-7e4f61cd",
    }
  );
  const services: string[] = [];
  await expect(
    claudeSubscriptionToken({
      env: { CLAUDE_CONFIG_DIR: "/cfg/work" },
      platform: "darwin",
      readCredentials: (path) => {
        services.push(path);
        return Promise.reject(new Error("no file"));
      },
      readKeychain: ({ service }) => {
        services.push(service);
        return Promise.reject(new Error("no entry"));
      },
    })
  ).rejects.toThrow("Claude Code subscription login is unavailable");
  expect(services).toEqual([
    "Claude Code-credentials-7e4f61cd",
    "/cfg/work/.credentials.json",
  ]);
});

it("asks the instance's configured Pi binary for its key", async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-pi-login-"));
  const bin = join(root, "my-pi");
  writeFileSync(bin, "#!/bin/sh\necho configured-pi-key\n");
  chmodSync(bin, 0o755);
  try {
    await expect(
      guestAuth("pi", { bin, env: { PATH: "/nonexistent" } })
    ).resolves.toEqual({ apiKey: "configured-pi-key", kind: "apiKey" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("refuses to guess a Claude Code login from an empty or relative path", async () => {
  const unlocatable: Record<string, string>[] = [
    { HOME: "" },
    { HOME: "relative/home" },
    { CLAUDE_CONFIG_DIR: "" },
    { CLAUDE_CONFIG_DIR: "cfg" },
    { CLAUDE_SECURESTORAGE_CONFIG_DIR: "store" },
  ];
  for (const env of unlocatable) {
    const readKeychain = vi.fn();
    await expect(
      claudeSubscriptionToken({ env, platform: "darwin", readKeychain })
    ).rejects.toThrow("login cannot be located");
    expect(readKeychain).not.toHaveBeenCalled();
  }
  await expect(
    claudeSubscriptionToken({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "t", HOME: "" },
      oauthToken: "t",
    })
  ).resolves.toBe("t");
  expect(
    claudeLoginLocation(
      { CLAUDE_SECURESTORAGE_CONFIG_DIR: "" },
      {
        home: "/home/me",
        user: "me",
      }
    )
  ).toEqual({
    account: "me",
    file: "/home/me/.claude/.credentials.json",
    service: "Claude Code-credentials",
  });
});
