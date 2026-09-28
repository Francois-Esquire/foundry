import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = join(PACKAGE_ROOT, "test/lib/fixtures/semantics");
const SERVER_URL = /Atlas: (http:\/\/\S+)/;
const SERVER_TIMEOUT_MS = 20_000;
// Packing, installing, and a fixture scan take well over Bun's 5s default.
const TEST_TIMEOUT_MS = 300_000;

function run(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 300_000,
    });
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      process.stderr.write(String(error.stdout));
    }
    if (error && typeof error === "object" && "stderr" in error) {
      process.stderr.write(String(error.stderr));
    }
    throw error;
  }
}

async function readServerUrl(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
    const url = SERVER_URL.exec(text)?.[1];
    if (url) {
      reader.releaseLock();
      return url;
    }
  }
  reader.releaseLock();
  throw new Error(`Server did not print its URL:\n${text}`);
}

test(
  "the tarball installs and its bin scans and serves a workspace",
  async () => {
    const consumer = mkdtempSync(join(tmpdir(), "atlas-package-"));
    try {
      const archive =
        process.env.PACKAGE_TARBALL ?? join(consumer, "package.tgz");
      if (!process.env.PACKAGE_TARBALL) {
        run(
          "bun",
          ["pm", "pack", "--ignore-scripts", "--filename", archive],
          PACKAGE_ROOT
        );
      }
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({
          dependencies: { "@foundry/atlas": `file:${archive}` },
          name: "atlas-package-consumer",
          private: true,
          type: "module",
        })
      );
      run("bun", ["install"], consumer);

      const installed = join(consumer, "node_modules/@foundry/atlas");
      const manifest = JSON.parse(
        readFileSync(join(installed, "package.json"), "utf8")
      );
      expect(manifest.private).toBe(false);
      expect(manifest.repository.directory).toBe("apps/atlas");
      expect(readFileSync(join(installed, "CHANGELOG.md"), "utf8")).toContain(
        manifest.version
      );
      expect(readFileSync(join(installed, "LICENSE"), "utf8")).toContain("MIT");
      expect(readdirSync(installed)).not.toContain("src");
      expect(existsSync(join(installed, "dist/cli/atlas.js"))).toBe(true);
      expect(existsSync(join(installed, "dist/cli/semantics-worker.js"))).toBe(
        true
      );
      expect(existsSync(join(installed, "dist/web/index.html"))).toBe(true);

      const cli = join(consumer, "node_modules/.bin/atlas");
      expect(run(cli, ["--help"], consumer)).toContain("atlas scan [path]");

      // The fixture is copied so the scan never touches the repository copy.
      const workspace = join(consumer, "workspace");
      cpSync(FIXTURE, workspace, { recursive: true });
      const state = join(consumer, "state");
      const scanned = run(
        cli,
        ["scan", workspace, "--state", state, "--no-open"],
        consumer
      );
      expect(scanned).toContain("Output saved to ");
      const output = scanned.split("Output saved to ")[1]?.trim() ?? "";
      const dataset = JSON.parse(
        readFileSync(join(output, "manifest.json"), "utf8")
      );
      expect(dataset.schemaVersion).toBe(3);
      expect(dataset.coverage).toBe("complete");
      expect(
        dataset.packages.filter(
          (entry: { status: string }) => entry.status === "complete"
        )
      ).toHaveLength(3);
      expect(existsSync(join(output, "internals"))).toBe(true);
      expect(existsSync(join(output, "manifests"))).toBe(true);

      const server = spawn(
        [cli, "serve", workspace, "--state", state, "--port", "0", "--no-open"],
        { cwd: consumer, stderr: "pipe", stdout: "pipe" }
      );
      try {
        const url = await readServerUrl(server.stdout);
        const index = await fetch(url);
        expect(index.status).toBe(200);
        expect(await index.text()).toContain("<html");
        const served = await fetch(new URL("data/manifest.json", url));
        expect(served.status).toBe(200);
        expect(await served.text()).toBe(
          readFileSync(join(output, "manifest.json"), "utf8")
        );
      } finally {
        server.kill();
        await server.exited;
      }
    } finally {
      rmSync(consumer, { force: true, recursive: true });
    }
  },
  TEST_TIMEOUT_MS
);
