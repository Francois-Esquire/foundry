import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const electronPath: unknown = createRequire(import.meta.url)("electron");
if (typeof electronPath !== "string") {
  throw new Error("Electron's launcher did not return its executable path");
}
const executable = electronPath;
const env = {
  ...process.env,
  ELECTRON_RENDERER_URL: undefined,
  ELECTRON_RUN_AS_NODE: undefined,
};

async function run(entry: string, args: string[] = []): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      [path.resolve(".cache/electron", entry), ...args],
      {
        env,
        stdio: "inherit",
      }
    );
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${entry} exceeded the smoke-test deadline`));
    }, 60_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${entry} failed with ${signal ?? code}`));
      }
    });
  });
}

const userData = await mkdtemp(path.join(tmpdir(), "works-module-smoke-"));
const streamProfile = path.join(userData, "stream-profile");
try {
  await run("vault-stream.smoke.cjs", [streamProfile]);
  await run("module-library.smoke.cjs", ["create", userData]);
  await run("module-library.smoke.cjs", ["reopen", userData]);
} finally {
  await rm(userData, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 100,
  });
}
