import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeContextRuntime } from "~/host/async-context";
import {
  ambient,
  createAmbientScope,
  type ExecutionContext,
} from "~/lib/async-context";
import { createPortableContextRuntime } from "~/lib/async-context/runtime";
import type { Current } from "~/lib/runs/scope";

const ALL_IMPORTS = /.*/;

const WORKSPACE_A: ExecutionContext = {
  cwd: "/ws/a",
  environment: { WS: "a" },
  workspaceId: "ws-a",
};

const WORKSPACE_B: ExecutionContext = {
  cwd: "/ws/b",
  environment: { WS: "b" },
  workspaceId: "ws-b",
};

describe("async-context portable entry", () => {
  it("supports isolated synchronous scopes without touching shared ambient state", () => {
    const scope = createAmbientScope(createPortableContextRuntime());
    const observed = scope.workspace.run(WORKSPACE_A, () => {
      expect(ambient.activeWorkspace()).toBeUndefined();
      expect(scope.activeWorkspace()).toBe(WORKSPACE_A);
      return scope.callingRun.run("rn-1", () => {
        expect(scope.callingRun.get()).toBe("rn-1");
        return scope.callingRun.exit(() => scope.callingRun.get());
      });
    });
    expect(observed).toBeUndefined();
    expect(scope.activeWorkspace()).toBeUndefined();
    expect(scope.callingRun.get()).toBeUndefined();
  });

  it("exits an inherited run when entering a different workspace context", () => {
    const scope = createAmbientScope(createPortableContextRuntime());
    const fakeRun = {
      bindings: { context: WORKSPACE_A },
    } as unknown as Current;
    scope.currentRun.run(fakeRun, () => {
      expect(scope.activeWorkspace()).toBe(WORKSPACE_A);
      scope.withinWorkspace(WORKSPACE_B, () => {
        expect(scope.currentRun.get()).toBeUndefined();
        expect(scope.activeWorkspace()).toBe(WORKSPACE_B);
      });
      expect(scope.currentRun.get()).toBe(fakeRun);
    });
  });

  it("uses an identity snapshot fallback in portable mode", () => {
    const scope = createAmbientScope(createPortableContextRuntime());
    const snap = scope.snapshot();
    expect(snap(() => 42)).toBe(42);
  });

  it("bundles src/lib/async-context/index.ts for the browser with zero Node built-ins", async () => {
    const builtins = new Set(
      builtinModules.map((name) => name.replace("node:", ""))
    );
    const forbidden: string[] = [];
    const built = await globalThis.Bun.build({
      entrypoints: [
        resolve(import.meta.dirname, "../../src/lib/async-context/index.ts"),
      ],
      plugins: [
        {
          name: "import-audit",
          setup(build) {
            build.onResolve({ filter: ALL_IMPORTS }, (args) => {
              if (args.path.startsWith("node:") || builtins.has(args.path)) {
                forbidden.push(`${args.importer} -> ${args.path}`);
                return { external: true, path: args.path };
              }
            });
          },
        },
      ],
      target: "browser",
    });
    expect(forbidden).toEqual([]);
    expect(built.success).toBe(true);
  });
});

describe("async-context node entry", () => {
  it("isolates concurrent async runs across awaits", async () => {
    const scope = createAmbientScope(createNodeContextRuntime());
    const [first, second] = await Promise.all([
      scope.callingRun.run("rn-a", async () => {
        await new Promise((done) => setTimeout(done, 15));
        return scope.callingRun.get();
      }),
      scope.callingRun.run("rn-b", async () => {
        await new Promise((done) => setTimeout(done, 5));
        return scope.callingRun.get();
      }),
    ]);
    expect(first).toBe("rn-a");
    expect(second).toBe("rn-b");
  });

  it("captures and restores async context via snapshot", () => {
    const scope = createAmbientScope(createNodeContextRuntime());
    const captured = scope.workspace.run(WORKSPACE_A, () =>
      scope.callingRun.run("rn-snap", () => scope.snapshot())
    );
    expect(scope.activeWorkspace()).toBeUndefined();
    expect(scope.callingRun.get()).toBeUndefined();
    const seen = captured(() => ({
      runId: scope.callingRun.get(),
      workspaceId: scope.activeWorkspace()?.workspaceId,
    }));
    expect(seen).toEqual({ runId: "rn-snap", workspaceId: "ws-a" });
  });
});
