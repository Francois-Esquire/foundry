import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

const LISTENING = /^listening (\d+)$/;

it.each(["relay", "abort", "unauthorized", "cancelled"])(
  "Program %s forwards cancellation or reports a terminal watch failure",
  {
    timeout: 10_000,
  },
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "sheets-program-"));
    await copyFile(
      new URL("../program.ts", import.meta.url),
      join(directory, "program.ts")
    );
    await writeFile(
      join(directory, "sdk.js"),
      `
export function createProgramGateway() {
  return {websocket: {message() {}}, client: {
    async call(alias, input, options) {
      if (input.wait) {
        await new Promise(resolve => {
          options?.signal?.addEventListener("abort", () => {console.log("call aborted"); resolve();}, {once: true});
          console.log("call started");
        });
      }
      return {signal: options?.signal instanceof AbortSignal};
    },
    async *observe(alias, input) {throw {code: input.binding};}
  }};
}
`
    );
    const process = spawn("bun", [join(directory, "program.ts")], {
      env: { ...globalThis.process.env, MODULE_HOST: "127.0.0.1", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    process.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const lines = createInterface({ input: process.stdout });
    const exited = once(process, "exit");
    try {
      const [line] = await Promise.race([
        once(lines, "line"),
        exited.then(() => {
          throw new Error(`Program exited before listening: ${stderr}`);
        }),
      ]);
      const port = String(line).match(LISTENING)?.[1];
      expect(port).toBeDefined();
      const origin = `http://127.0.0.1:${port}`;
      if (scenario === "relay") {
        const answer = await fetch(`${origin}/_module/artifacts`, {
          body: JSON.stringify({ alias: "binding", input: { binding: "b" } }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(await answer.json()).toEqual({
          ok: true,
          output: { signal: true },
        });
      } else if (scenario === "abort") {
        const controller = new AbortController();
        const started = once(lines, "line");
        const request = fetch(`${origin}/_module/artifacts`, {
          body: JSON.stringify({ alias: "read", input: { wait: true } }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        const rejected = expect(request).rejects.toThrow();
        expect(await started).toEqual(["call started"]);
        const aborted = once(lines, "line");
        controller.abort();
        await rejected;
        expect(await aborted).toEqual(["call aborted"]);
      } else {
        const watch = await fetch(
          `${origin}/_module/artifacts/watch?binding=${scenario}`
        );
        expect(await watch.text()).toContain('"terminal":true');
      }
    } finally {
      process.kill();
      await exited;
      lines.close();
      await rm(directory, { force: true, recursive: true });
    }
  }
);
