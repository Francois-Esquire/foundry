import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createModuleGateway } from "@foundry/modules/gateway/module-gateway";
import type { ModuleView } from "@foundry/modules/management";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import { createModuleProxy } from "~/main/modules/runtime/proxy";
import { connectModuleSocket } from "~/main/modules/runtime/websocket";
import { composeTestWorks } from "./works";

export type Cleanups = (() => Promise<void>)[];

const EVENT_PREFIX = /^data: /;

async function startProgram(
  release: string,
  cleanups: Cleanups
): Promise<string> {
  const child = spawn("bun", [path.join(release, "outputs/program.js")], {
    env: { ...process.env, MODULE_HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  cleanups.push(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  const lines = createInterface({ input: child.stdout });
  const [line] = (await once(lines, "line", {
    signal: AbortSignal.timeout(10_000),
  })) as [string];
  return `http://127.0.0.1:${line.replace("listening ", "")}`;
}

export function events(response: Response) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<Record<string, unknown> | null> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const event = buffer.slice(0, boundary).replace(EVENT_PREFIX, "");
          buffer = buffer.slice(boundary + 2);
          return JSON.parse(event) as Record<string, unknown>;
        }
        const read = await reader?.read();
        if (!read || read.done) {
          return null;
        }
        buffer += decoder.decode(read.value, { stream: true });
      }
    },
    stop: () => reader?.cancel(),
  };
}

export async function composeModuleWorks(cleanups: Cleanups) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "works-fixture-"))
  );
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const composed = await composeTestWorks(root);
  cleanups.push(() => composed.works.close());
  return composed;
}

export async function runModuleApp({
  cleanups,
  composed: { programs, works },
  moduleId,
  views,
}: {
  readonly cleanups: Cleanups;
  readonly composed: Awaited<ReturnType<typeof composeModuleWorks>>;
  readonly moduleId: string;
  readonly views: ModuleView[];
}) {
  const contentId = (await works.rpc.modules.details(moduleId))?.releases[0]
    ?.contentId;
  const version = contentId
    ? await works.rpc.modules.release(moduleId, contentId)
    : null;
  if (!version) {
    throw new Error("Imported release missing");
  }
  const requested = new Set(
    version.manifest.capabilities.map(({ capability }) => capability)
  );
  for (const capability of requested) {
    await works.rpc.access.approve(moduleId, capability);
  }

  const app = await works.testing.runtime.start(
    version,
    new AbortController().signal
  );
  cleanups.push(() => app.close());
  const runtime = await programs.programs.active(
    moduleInstallationId(moduleId)
  );
  const release = programs.mounted.at(-1);
  if (!(runtime && release)) {
    throw new Error("Program not started");
  }
  const origin = await startProgram(release, cleanups);
  const session = await createModuleGateway({
    runtimeDispatcher: programs.invocations,
    store: works.testing.persistence.modules,
  }).connect({
    capabilities: version.manifest.capabilities,
    runtime,
    transport: await connectModuleSocket({
      url: new URL("/_foundry/module-gateway", origin.replace("http:", "ws:")),
    }),
  });
  cleanups.push(() => session.close("test complete"));
  const endpoint = { origin, signal: new AbortController().signal, views };
  const proxy = createModuleProxy({ endpoint: () => endpoint }, fetch);
  const view = (pathname: string, init?: RequestInit) =>
    proxy(new Request(new URL(pathname, "module-app://token"), init));
  const follow = (pathname: string) =>
    view(pathname, { headers: { accept: "text/event-stream" } });
  const call = async <T>(
    alias: string,
    input: unknown,
    route = "/_module/artifacts"
  ) => {
    const response = await view(route, {
      body: JSON.stringify({ alias, input }),
      method: "POST",
    });
    return (await response.json()) as
      | { code: string; ok: false }
      | { ok: true; output: T };
  };
  return { call, follow, view };
}
