import { expect, it, vi } from "vitest";
import {
  claudeSubscriptionToken,
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
