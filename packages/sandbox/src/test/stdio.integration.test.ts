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

  it("preserves binary streams and EOF through the public piped process interface", async () => {
    const child = await sandbox.spawn([
      "bun",
      "-e",
      `
      process.stdin.pipe(process.stdout);
      process.stderr.write(Buffer.from([0, 255, 128]));
      process.stdin.on("end", () => { process.exitCode = 7; });
    `,
    ]);
    const output = Array.fromAsync(child.stdout);
    const diagnostics = Array.fromAsync(child.stderr);
    const input = Buffer.alloc(1024 * 1024, 255);
    child.stdin.end(input);
    const [stdout, stderr, result] = await Promise.all([
      output,
      diagnostics,
      child.exited,
    ]);
    expect(Buffer.concat(stdout)).toEqual(input);
    expect(Buffer.concat(stderr)).toEqual(Buffer.from([0, 255, 128]));
    expect(result.exitCode).toBe(7);
  }, 30_000);

  it("aborts a live piped process and rejects its completion", async () => {
    const controller = new AbortController();
    const child = await sandbox.spawn(
      ["bun", "-e", "setInterval(() => {}, 1000)"],
      {
        signal: controller.signal,
      }
    );
    child.stdout.resume();
    child.stderr.resume();
    const completion = expect(child.exited).rejects.toThrow();
    controller.abort(new Error("cancelled fixture"));
    await completion;
  }, 30_000);

  it("refuses an already aborted launch", async () => {
    await expect(
      sandbox.spawn(["bun", "--version"], {
        signal: AbortSignal.abort(new Error("cancelled before launch")),
      })
    ).rejects.toThrow("cancelled before launch");
  });

  it("sends a named signal and reports the native exit lifecycle", async () => {
    const child = await sandbox.spawn([
      "bun",
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    child.stdout.resume();
    child.stderr.resume();
    const event = new Promise<number | null>((resolve) =>
      child.once("exit", resolve)
    );
    expect(child.kill("SIGTERM")).toBe(true);
    expect(child.killed).toBe(true);
    // SDK 0.6.18 reports -1 for signaled exits and omits the signal.
    expect((await child.exited).exitCode).toBe(-1);
    expect(await event).toBe(-1);
    expect(child.exitCode).toBe(-1);
    expect(child.kill()).toBe(false);
  }, 30_000);

  it("aborts output blocked by backpressure and reaps the guest process", async () => {
    const controller = new AbortController();
    const marker = `/tmp/piped-pid-${crypto.randomUUID()}`;
    const child = await sandbox.spawn(
      [
        "bun",
        "-e",
        `
      await Bun.write(${JSON.stringify(marker)}, String(process.pid));
      const chunk = Buffer.alloc(1024 * 1024, 255);
      setInterval(() => process.stdout.write(chunk), 5);
    `,
      ],
      { signal: controller.signal }
    );
    child.stderr.resume();
    await expect
      .poll(async () => (await sandbox.exec(["test", "-f", marker])).exitCode)
      .toBe(0);
    const pid = (await sandbox.readTextFile(marker)).trim();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const completion = expect(child.exited).rejects.toThrow(
      "blocked output abort"
    );
    controller.abort(new Error("blocked output abort"));
    await completion;
    await expect
      .poll(
        async () =>
          (await sandbox.exec(["test", "-d", `/proc/${pid}`])).exitCode
      )
      .not.toBe(0);
    expect(child.stdout.destroyed).toBe(true);
  }, 30_000);

  it("rejects an abort during launch without leaving the guest process running", async () => {
    const controller = new AbortController();
    const marker = `/tmp/launch-pid-${crypto.randomUUID()}`;
    const pending = sandbox.spawn(
      [
        "bun",
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
      ],
      { signal: controller.signal }
    );
    controller.abort(new Error("launch abort fixture"));
    await expect(pending).rejects.toThrow("launch abort fixture");
    await new Promise((resolve) => setTimeout(resolve, 100));
    if ((await sandbox.exec(["test", "-f", marker])).exitCode === 0) {
      const pid = (await sandbox.readTextFile(marker)).trim();
      await expect
        .poll(
          async () =>
            (await sandbox.exec(["test", "-d", `/proc/${pid}`])).exitCode
        )
        .not.toBe(0);
    }
  }, 30_000);

  it("reports a missing executable as a launch error", async () => {
    const child = await sandbox.spawn(["/missing-executable-fixture"]);
    child.stdout.resume();
    child.stderr.resume();
    await expect(child.exited).rejects.toThrow(
      "exec session ended without exit event"
    );
  });
});
