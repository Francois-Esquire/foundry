import { runInNewContext } from "node:vm";

import { ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

import { buildModuleSdkPack } from "../sdk";
import { composeModuleTemplate } from "../template/compose";
import { upgradeModuleWorkspaceSource } from "../template/upgrade";
import { reactModuleBase } from "./helpers/module-base";

const SERVER_PATH = "packages/server/src/index.ts";
const LEGACY_GATEWAY = `const gatewayModes = new WeakMap<object, "development" | "runtime">();
Bun.serve({
  websocket: {
    message(socket, message) {
      if (typeof message !== "string") {
        socket.close(1003, "Gateway accepts JSON text frames");
        return;
      }
      try {
        const frame: unknown = JSON.parse(message);
        if (
          typeof frame !== "object" || frame === null || Array.isArray(frame) ||
          (frame as { kind?: unknown }).kind !== "hello" ||
          (frame as { protocol?: unknown }).protocol !== 1 ||
          ((frame as { mode?: unknown }).mode !== "development" &&
            (frame as { mode?: unknown }).mode !== "runtime")
        ) {
          socket.close(1002, "Gateway hello is invalid");
          return;
        }
        const mode = (frame as { readonly mode: "development" | "runtime" }).mode;
        gatewayModes.set(socket, mode);
        socket.send(JSON.stringify({ kind: "ready", protocol: 1, mode }));
      } catch {
        socket.close(1007, "Gateway frame is not JSON");
      }
    },
    close(socket) { gatewayModes.delete(socket); },
  },
});
`;

describe("generated Program heartbeats", () => {
  it.each(["runtime", "development"])(
    "answers successive %s heartbeats without closing",
    async (mode) => {
      const files = await workspaceFiles();
      assertHeartbeatReplies(files[SERVER_PATH] ?? "", mode);
    }
  );

  it("repairs an existing hello-only Program without changing application source", async () => {
    const files = await workspaceFiles();
    const source: Record<string, string> = {
      ...files,
      [SERVER_PATH]: `const applicationMarker = "preserve me";\n${LEGACY_GATEWAY}`,
    };
    const upgraded = upgradeModuleWorkspaceSource(source);

    assertHeartbeatReplies(upgraded[SERVER_PATH] ?? "", "runtime");
    expect(upgraded[SERVER_PATH]).toContain(
      'const applicationMarker = "preserve me";'
    );
    expect(upgraded["packages/app/src/App.tsx"]).toBe(
      source["packages/app/src/App.tsx"]
    );
    expect(upgradeModuleWorkspaceSource(upgraded)).toBe(upgraded);
  });
});

async function workspaceFiles() {
  const template = await composeModuleTemplate({
    base: reactModuleBase,
    project: {
      displayName: "Heartbeat test",
      id: "heartbeat-test",
      packageName: "heartbeat-test",
    },
    sdk: await buildModuleSdkPack(),
  });
  return template.files;
}

function assertHeartbeatReplies(source: string, mode: string): void {
  const socket = { close: vi.fn(), send: vi.fn<(data: string) => void>() };
  let handler:
    | { message(target: typeof socket, message: string): void }
    | undefined;
  const start = source.indexOf("const gatewayModes =");
  expect(start).toBeGreaterThanOrEqual(0);
  runInNewContext(
    transpileModule(source.slice(start), {
      compilerOptions: { target: ScriptTarget.ESNext },
    }).outputText,
    {
      Bun: {
        serve(options: { websocket: NonNullable<typeof handler> }) {
          handler = options.websocket;
        },
      },
      port: 3000,
    }
  );
  if (handler === undefined) {
    throw new Error("Program did not register its gateway");
  }
  handler.message(socket, JSON.stringify({ kind: "hello", mode, protocol: 1 }));
  const unbound = { close: vi.fn(), send: vi.fn() };
  handler.message(unbound, JSON.stringify({ kind: "heartbeat", sequence: 1 }));
  expect(unbound.close).toHaveBeenCalledWith(1002, "Gateway hello is invalid");
  expect(unbound.send).not.toHaveBeenCalled();
  for (const sequence of [1, 2, 3]) {
    handler.message(socket, JSON.stringify({ kind: "heartbeat", sequence }));
  }
  expect(socket.close).not.toHaveBeenCalled();
  expect(
    socket.send.mock.calls.map(([data]) => JSON.parse(data) as unknown)
  ).toEqual([
    { kind: "ready", mode, protocol: 1 },
    { kind: "heartbeat", sequence: 1 },
    { kind: "heartbeat", sequence: 2 },
    { kind: "heartbeat", sequence: 3 },
  ]);
}
