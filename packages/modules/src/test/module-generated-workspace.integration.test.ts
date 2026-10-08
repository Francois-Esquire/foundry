import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { buildModuleSdkPack } from "../sdk";
import {
  composeModuleTemplate,
  moduleTemplateBaseIssue,
} from "../template/compose";
import { reactModuleBase } from "./helpers/module-base";

const runGeneratedWorkspace =
  process.env.FOUNDRY_RUN_GENERATED_MODULE_WORKSPACE === "1";
const execute = promisify(execFile);

describe.skipIf(!runGeneratedWorkspace)("generated Module workspace", () => {
  it("installs, serves generated typed operations, and persists state across restarts", async () => {
    expect(moduleTemplateBaseIssue(reactModuleBase)).toBeNull();
    const root = await mkdtemp(path.join(tmpdir(), "foundry-module-graphql-"));
    try {
      const workspace = await composeModuleTemplate({
        base: reactModuleBase,
        project: {
          displayName: "Generated Module",
          id: "generated-module",
          packageName: "generated-module",
        },
        sdk: await buildModuleSdkPack(),
      });
      await materialize(root, workspace.files);

      await run(root, [
        "install",
        "--offline",
        "--ignore-scripts",
        "--minimum-release-age",
        "0",
      ]);
      await run(root, ["run", "generate"]);
      await run(root, ["run", "validate"]);

      await expect(
        readText(root, "packages/app/generated/client/graphql.ts")
      ).resolves.toContain("ModuleHealthDocument");

      const port = 32_000 + Math.floor(Math.random() * 1000);
      await withServer(root, port, { NODE_ENV: "production" }, async () => {
        await runTypedMutation(root, port);
        await assertGatewayHandshake(port);
        const introspection = await executeOperation(
          port,
          "{ __schema { queryType { name } } }"
        );
        expect(
          introspection.errors,
          JSON.stringify(introspection)
        ).toBeDefined();
      });
      await withServer(root, port, { NODE_ENV: "production" }, async () => {
        await runTypedQuery(root, port);
      });
      await withDevServer(root, port, async (applicationPort) => {
        const application = await fetch(`http://localhost:${applicationPort}/`);
        expect(application.status).toBe(200);
        expect(application.url).toBe(`http://localhost:${applicationPort}/`);
        expect(applicationPort).not.toBe(port);
        expect(await application.text()).toContain('<div id="root"></div>');
        const health = await fetch(
          `http://localhost:${applicationPort}/_foundry/health`
        );
        expect(await health.json()).toEqual({ status: "ready" });
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 180_000);
});

async function materialize(
  root: string,
  files: Readonly<Record<string, string>>
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([relative, content]) => {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    })
  );
}

async function run(
  root: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {}
): Promise<void> {
  try {
    const temporaryDirectory = path.join(root, ".tmp");
    await mkdir(temporaryDirectory, { recursive: true });
    await execute("bun", [...args], {
      cwd: root,
      env: {
        ...process.env,
        ...env,
        FOUNDRY_MODULE_DATA_PATH: path.join(root, "installation-data.sqlite"),
        TMPDIR: temporaryDirectory,
      },
      timeout: 45_000,
    });
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    throw new Error(
      `generated workspace command bun ${args.join(" ")} failed: ${output.stderr ?? output.stdout ?? "no output"}`,
      { cause: error }
    );
  }
}

async function withServer(
  root: string,
  port: number,
  env: NodeJS.ProcessEnv,
  action: () => Promise<void>
): Promise<void> {
  await withRunningProcess(root, ["run", "start"], port, env, action);
}

async function withDevServer(
  root: string,
  port: number,
  action: (applicationPort: number) => Promise<void>
): Promise<void> {
  const applicationPort = port + 1;
  await withRunningProcess(
    root,
    ["run", "dev"],
    port,
    { VITE_PORT: String(applicationPort) },
    async () => {
      await waitForPort(applicationPort);
      await action(applicationPort);
    }
  );
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isReady(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`development application did not become ready on ${port}`);
}

async function withRunningProcess(
  root: string,
  args: readonly string[],
  port: number,
  env: NodeJS.ProcessEnv,
  action: () => Promise<void>
): Promise<void> {
  const output: string[] = [];
  const temporaryDirectory = path.join(root, ".tmp");
  await mkdir(temporaryDirectory, { recursive: true });
  const child = spawn("bun", [...args], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      FOUNDRY_MODULE_DATA_PATH: path.join(root, "installation-data.sqlite"),
      PORT: String(port),
      TMPDIR: temporaryDirectory,
    },
  });
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  try {
    await waitForReady(child, port, output);
    await action();
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) =>
        child.once("exit", () => {
          resolve();
        })
      ),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000)
      ),
    ]);
  }
}

async function waitForReady(
  child: ReturnType<typeof spawn>,
  port: number,
  output: readonly string[]
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `generated server exited before becoming ready: ${output.join("")}`
      );
    }
    try {
      if (await isReady(port)) {
        return;
      }
    } catch {
      // The Program has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`generated server did not become ready: ${output.join("")}`);
}

async function isReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(
      `http://localhost:${port}/_foundry/health`,
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      }
    );
    request.once("error", () => {
      resolve(false);
    });
    request.setTimeout(100, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function assertGatewayHandshake(port: number): Promise<void> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${String(port)}/_foundry/module-gateway`
  );
  await new Promise<void>((resolve, reject) => {
    let sequence = 0;
    let complete = false;
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          binding: {
            generation: 1,
            installationId: "installation-1",
            moduleId: "module-1",
            releaseId: "release-1",
            runtimeInstanceId: "runtime-1",
          },
          kind: "hello",
          mode: "runtime",
          protocol: 1,
        })
      );
    });
    socket.addEventListener("message", (event) => {
      try {
        expect(JSON.parse(String(event.data))).toEqual(
          sequence === 0
            ? { kind: "ready", mode: "runtime", protocol: 1 }
            : { kind: "heartbeat", sequence }
        );
        if (sequence === 3) {
          complete = true;
          socket.close();
          resolve();
          return;
        }
        sequence += 1;
        socket.send(JSON.stringify({ kind: "heartbeat", sequence }));
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error("generated Program Gateway response was invalid")
        );
      }
    });
    socket.addEventListener("error", () => {
      reject(new Error("generated Program Gateway connection failed"));
    });
    socket.addEventListener("close", () => {
      if (!complete) {
        reject(
          new Error(
            "generated Program Gateway closed before answering heartbeats"
          )
        );
      }
    });
  });
}

async function runTypedMutation(root: string, port: number): Promise<void> {
  await run(root, [
    "--cwd",
    "packages/app",
    "-e",
    `import { print } from "graphql";
import { CreateModuleNoteDocument } from "./generated/client/graphql";
const response = await fetch("http://localhost:${port}/_module/graphql", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    query: print(CreateModuleNoteDocument),
    variables: { values: { body: "survives restart" } },
  }),
});
const body = await response.json();
if (body.errors || body.data?.insertIntoNotesSingle?.body !== "survives restart") {
  throw new Error(JSON.stringify(body));
}
`,
  ]);
}

async function runTypedQuery(root: string, port: number): Promise<void> {
  await run(root, [
    "--cwd",
    "packages/app",
    "-e",
    `import { print } from "graphql";
import { ModuleNotesDocument } from "./generated/client/graphql";
const response = await fetch("http://localhost:${port}/_module/graphql", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: print(ModuleNotesDocument) }),
});
const body = await response.json();
if (body.errors || !body.data?.notes?.some((note) => note.body === "survives restart")) {
  throw new Error(JSON.stringify(body));
}
`,
  ]);
}

async function executeOperation(
  port: number,
  query: string
): Promise<{ readonly errors?: unknown }> {
  const response = await fetch(`http://localhost:${port}/_module/graphql`, {
    body: JSON.stringify({ query }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return (await response.json()) as { readonly errors?: unknown };
}

async function readText(root: string, relative: string): Promise<string> {
  return readFile(path.join(root, relative), "utf8");
}
