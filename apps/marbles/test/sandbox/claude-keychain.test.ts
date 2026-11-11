import { expect, it, vi } from "vitest";
import { claudeSubscriptionToken } from "~/lib/sandbox/credentials";

const calls = vi.hoisted(
  () => [] as { args: string[]; env?: Record<string, string>; file: string }[]
);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (
    file: string,
    args: string[],
    options: { env?: Record<string, string> },
    callback: (error: Error | null, result?: unknown) => void
  ) => {
    calls.push({ args, file, ...(options.env ? { env: options.env } : {}) });
    callback(null, {
      stderr: "",
      stdout: JSON.stringify({
        claudeAiOauth: {
          accessToken: "work",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    });
  },
}));

it("asks the keychain under the instance's own HOME, as its CLI does", async () => {
  const env = {
    CLAUDE_CONFIG_DIR: "/cfg/work",
    HOME: "/Users/work",
    USER: "work",
  };
  await expect(
    claudeSubscriptionToken({ env, platform: "darwin" })
  ).resolves.toBe("work");
  expect(calls).toEqual([
    {
      args: [
        "find-generic-password",
        "-a",
        "work",
        "-w",
        "-s",
        "Claude Code-credentials-7e4f61cd",
      ],
      env,
      file: "/usr/bin/security",
    },
  ]);
});
