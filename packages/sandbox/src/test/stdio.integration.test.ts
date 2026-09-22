import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Sandbox as MicroSandbox } from "microsandbox";
import { beforeAll, describe, expect, it } from "vitest";

import { createMicrosandboxRuntime } from "../container/microsandbox-runtime";
import {
  provisionContainerSandbox,
  startContainerSandbox,
} from "../container/sandbox";
import type { ContainerSandbox } from "../container/types";

const PACKAGE_URL = new URL("../../", import.meta.url);
const GUEST_PACKAGE_PATH = "/mounts/sandbox";
const OUTPUT_TIMEOUT_MS = 5000;

const ECHO_PROGRAM = `
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  process.stdout.write("stdout:" + line + "\\n");
  process.stderr.write("stderr:" + line + "\\n");
}
process.stdout.write("stdin:eof\\n");
`;

describe("real MicroSandbox command IO", () => {
  let sandbox: ContainerSandbox<MicroSandbox>;

  beforeAll(async () => {
    const runtime = createMicrosandboxRuntime();
    if (!(await runtime.isInstalled())) {
      throw new Error(
        "Install the MicroSandbox runtime before running test:integration"
      );
    }
    const source = await realpath(fileURLToPath(PACKAGE_URL));
    const provisioned = await provisionContainerSandbox(
      {
        disableNetwork: true,
        image: "docker.io/oven/bun:1-slim",
        workdir: GUEST_PACKAGE_PATH,
      },
      { runtime },
      [
        {
          id: "package",
          readOnly: true,
          source,
          target: GUEST_PACKAGE_PATH,
        },
      ]
    );
    sandbox = await startContainerSandbox(provisioned);
    return () => sandbox.remove();
  }, 120_000);

  it("lists and reads the mounted package, preserving stdout, stderr, and exit status", async () => {
    const listing = await sandbox.exec([
      "ls",
      "-1",
      "package.json",
      "README.md",
    ]);
    expect(listing).toMatchObject({ exitCode: 0, stderr: "" });
    expect(listing.stdout.trim().split("\n").sort()).toEqual([
      "README.md",
      "package.json",
    ]);

    const [manifest, readme] = await Promise.all([
      readFile(new URL("package.json", PACKAGE_URL), "utf8"),
      readFile(new URL("README.md", PACKAGE_URL), "utf8"),
    ]);
    expect(await sandbox.exec(["cat", "package.json", "README.md"])).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: manifest + readme,
    });

    const missingPath = `/missing-stdio-${crypto.randomUUID()}`;
    const missing = await sandbox.exec(["cat", missingPath]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain(missingPath);
  }, 30_000);

  it("streams terminal responses before the next stdin write and accepts terminal EOF", async () => {
    const shell = await sandbox.openShell({
      command: ["bun", "-e", ECHO_PROGRAM],
    });
    let output = "";
    const unsubscribe = shell.onData((chunk) => {
      output += chunk;
    });
    const normalizedOutput = () => output.replaceAll("\r\n", "\n");

    try {
      shell.write("first\n");
      await expect
        .poll(normalizedOutput, { timeout: OUTPUT_TIMEOUT_MS })
        .toContain("stdout:first\n");
      await expect
        .poll(normalizedOutput, { timeout: OUTPUT_TIMEOUT_MS })
        .toContain("stderr:first\n");

      shell.write("second café 🧪\n");
      await expect
        .poll(normalizedOutput, { timeout: OUTPUT_TIMEOUT_MS })
        .toContain("stdout:second café 🧪\n");
      await expect
        .poll(normalizedOutput, { timeout: OUTPUT_TIMEOUT_MS })
        .toContain("stderr:second café 🧪\n");
      expect(normalizedOutput()).not.toContain("stdin:eof\n");

      // A terminal uses Ctrl-D for EOF; closing its input pipe is not EOF.
      shell.write("\u0004");
      await expect
        .poll(normalizedOutput, { timeout: OUTPUT_TIMEOUT_MS })
        .toContain("stdin:eof\n");
    } finally {
      unsubscribe();
      await shell.close();
    }
  }, 30_000);

  it("streams separate native stdout and stderr, split UTF-8 input, and pipe EOF", async () => {
    // The public shell is a TTY. Separate live pipes currently need the SDK.
    await using handle = await sandbox.native.execStreamWith("bun", (builder) =>
      builder.args(["-e", ECHO_PROGRAM]).tty(false).stdinPipe()
    );
    const stdin = await handle.takeStdin();
    if (stdin === null) {
      throw new Error("MicroSandbox did not provide a stdin pipe");
    }
    await using input = stdin;
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let exitCode: number | undefined;
    const drain = (async () => {
      for await (const event of handle) {
        if (event.kind === "stdout") {
          stdout.push(event.data);
        } else if (event.kind === "stderr") {
          stderr.push(event.data);
        } else if (event.kind === "exited") {
          exitCode = event.code;
        }
      }
    })();
    const stdoutText = () => Buffer.concat(stdout).toString("utf8");
    const stderrText = () => Buffer.concat(stderr).toString("utf8");

    try {
      await input.write("first\n");
      await expect
        .poll(stdoutText, { timeout: OUTPUT_TIMEOUT_MS })
        .toBe("stdout:first\n");
      await expect
        .poll(stderrText, { timeout: OUTPUT_TIMEOUT_MS })
        .toBe("stderr:first\n");
      expect(exitCode).toBeUndefined();

      const secondLine = "second café 🧪";
      const bytes = new TextEncoder().encode(`${secondLine}\n`);
      // Split inside the emoji so the guest must preserve bytes across writes.
      await input.write(bytes.subarray(0, bytes.length - 3));
      await input.write(bytes.subarray(bytes.length - 3));
      await expect
        .poll(stdoutText, { timeout: OUTPUT_TIMEOUT_MS })
        .toBe(`stdout:first\nstdout:${secondLine}\n`);
      await expect
        .poll(stderrText, { timeout: OUTPUT_TIMEOUT_MS })
        .toBe(`stderr:first\nstderr:${secondLine}\n`);
      expect(exitCode).toBeUndefined();

      await input.close();
      await expect.poll(() => exitCode, { timeout: OUTPUT_TIMEOUT_MS }).toBe(0);
      await drain;
      expect(stdoutText()).toBe(
        `stdout:first\nstdout:${secondLine}\nstdin:eof\n`
      );
      expect(stderrText()).toBe(`stderr:first\nstderr:${secondLine}\n`);
    } finally {
      await handle[Symbol.asyncDispose]();
      await drain;
    }
  }, 30_000);
});
