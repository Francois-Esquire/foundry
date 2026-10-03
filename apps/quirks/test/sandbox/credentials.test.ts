import { expect, it, vi } from "vitest";
import { claudeSubscriptionToken } from "~/sandbox/credentials";

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
