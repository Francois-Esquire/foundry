import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agent,
  artifact,
  Catalog,
  collectCatalog,
  defineConfig,
  defineWorkspace,
  monitor,
  observe,
  sandbox,
  schedule,
  step,
  workflow,
  workspace,
} from "@foundry.sh/marbles";
import { defineProvider } from "@foundry.sh/marbles/providers";
import { vercel } from "@foundry.sh/marbles/providers/vercel";
import { afterEach, describe, expect, it } from "vitest";
import type { InstanceRuntime } from "~/authoring/runtime";
import { releaseEngine, runLoadScope, setHost } from "~/authoring/runtime";
import {
  CommonJsModuleError,
  detectLoaderAdapter,
  openLoadSession,
  UnsupportedLoaderRuntimeError,
} from "~/workspace/loader";
import { openWorkspace } from "~/workspace/open";
import { testHome } from "./helpers/home";

const MARBLES_DIR = resolve(import.meta.dirname, "..");
const DIST_IMPORT = /(?:from|import)\s*["']([^"']+)["']/g;
const AMBIGUOUS_WORKSPACE = /Ambiguous|hosts 2/;

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) {
    fn();
  }
});

function stubRuntime(workspaceId: string): InstanceRuntime & {
  disposed: boolean;
  readonly executed: string[];
} {
  const executed: string[] = [];
  const runtime = {
    context: { cwd: "/", environment: {}, workspaceId },
    disposed: false,
    execute(definition: { readonly name?: string }) {
      executed.push(definition.name ?? "anonymous");
      return Promise.resolve(`ran:${workspaceId}`);
    },
    executed,
    workspaceId,
  };
  return runtime as unknown as InstanceRuntime & {
    disposed: boolean;
    readonly executed: string[];
  };
}

describe("portable authoring and export-based registration", () => {
  it("constructs pure declarations with zero global catalog mutation", () => {
    const build = step("build").do(() => "ok");
    const deploy = workflow("deploy", build());
    const reviewer = agent({ prompt: "Review code." });
    const extended = reviewer.extend({ provider: "codex" });
    const repo = workspace({ path: "./repo" });
    const box = sandbox({ image: "node:22" });
    const report = artifact({ name: "report", type: "markdown" });
    const nightly = schedule(deploy).every("1h");
    const watchSrc = monitor("src/**/*.ts").do(() => undefined);
    const onRun = observe(workflow, () => undefined, { name: "on-run" });
    const provider = defineProvider(vercel);
    const config = defineConfig({ pool: "fast", pools: { fast: 2 } });

    const collected = collectCatalog(
      defineWorkspace({
        agents: [extended, reviewer],
        artifacts: [report],
        config,
        definitions: [build, deploy],
        monitors: [watchSrc],
        observers: [onRun],
        providers: [provider],
        sandboxes: [box],
        schedules: [nightly],
        workspaces: [repo],
      })
    );

    expect([...collected.definitions.keys()].sort()).toEqual([
      "build",
      "deploy",
    ]);
    expect(collected.agentIdOf(reviewer)).toBe(collected.agentIdOf(extended));
    expect(collected.workspaces.has("./repo")).toBe(true);
    expect(collected.sandboxes.has(box.id)).toBe(true);
    expect(collected.artifacts.has(report.id)).toBe(true);
    expect(collected.schedules.size).toBe(1);
    expect(collected.monitors.size).toBe(1);
    expect(collected.observers.length).toBe(1);
    expect(collected.providers.has("vercel")).toBe(true);
    expect(collected.poolForDefinition(build)).toBe("fast");
  });

  it("infers names from exports, keeps sequential synthetic scopes distinct, and handles module namespaces", () => {
    const one = step().do(() => 1);
    const base = agent({ prompt: "Review." });
    const fast = base.extend({ provider: "codex" });

    const ns = Object.freeze({
      fast,
      kind: "step",
      name: "phantom",
      one,
      reviewer: base,
      [Symbol.toStringTag]: "Module",
    });

    const collected = collectCatalog({ exports: ns });
    expect([...collected.definitions.keys()]).toEqual(["one"]);
    expect([...collected.agents.keys()]).toEqual(["reviewer"]);
    expect(collected.agentIdOf(fast)).toBe("reviewer");

    const namedOne = step("one").do(() => 1);
    const namedTwo = step("two").do(() => 2);
    const sequential = new Catalog();
    sequential.collect(
      defineWorkspace({
        config: defineConfig({ pool: "fast", pools: { fast: 1 } }),
        definitions: [namedOne],
      })
    );
    sequential.collect(
      defineWorkspace({
        config: defineConfig({ pool: "slow", pools: { slow: 2 } }),
        definitions: [namedTwo],
      })
    );
    sequential.validate();
    expect(sequential.poolForDefinition(namedOne)).toBe("fast");
    expect(sequential.poolForDefinition(namedTwo)).toBe("slow");
  });

  it("isolates load scope from unrelated steps and routes post-load callbacks once hosted", async () => {
    let release!: () => void;
    const paused = new Promise<void>((done) => {
      release = done;
    });
    let ping!: ReturnType<ReturnType<typeof step>["do"]>;
    let scheduled!: Promise<unknown>;

    const loadPromise = runLoadScope(
      { dry: false, workspaceId: "alpha" },
      async () => {
        ping = step("ping").do(() => "pong");
        scheduled = new Promise<unknown>((done, fail) => {
          setTimeout(() => {
            ping.run().then(done, fail);
          }, 25);
        });
        await paused;
      }
    );

    const unrelated = step("unrelated").do(() => "ok");
    release();
    await loadPromise;

    const alpha = stubRuntime("alpha");
    const beta = stubRuntime("beta");
    setHost(alpha);
    setHost(beta);
    cleanup.push(() => {
      alpha.disposed = true;
      beta.disposed = true;
      releaseEngine(alpha);
      releaseEngine(beta);
    });

    await expect(unrelated.run()).rejects.toThrow(AMBIGUOUS_WORKSPACE);
    await expect(scheduled).resolves.toBe("ran:alpha");
    expect(alpha.executed).toEqual(["ping"]);
    expect(beta.executed).toEqual([]);
  });

  it("keeps dist/index.js 100% portable and preserves CommandError and scope bridge across bundles", () => {
    const distDir = resolve(MARBLES_DIR, "dist");
    const visited = new Set<string>();
    const queue = [resolve(distDir, "index.js")];
    const imports: string[] = [];

    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || visited.has(file)) {
        continue;
      }
      visited.add(file);
      const content = readFileSync(file, "utf8");
      DIST_IMPORT.lastIndex = 0;
      let match = DIST_IMPORT.exec(content);
      while (match !== null) {
        const [, spec] = match;
        if (spec !== undefined) {
          if (spec.startsWith(".")) {
            queue.push(resolve(dirname(file), spec));
          } else {
            imports.push(spec);
          }
        }
        match = DIST_IMPORT.exec(content);
      }
    }

    expect(imports).not.toContain("effect");
    expect(imports).not.toContain("croner");
    expect(imports.some((spec) => spec.startsWith("node:"))).toBe(false);
    expect(imports.some((spec) => spec.includes("async_hooks"))).toBe(false);

    const root = mkdtempSync(join(tmpdir(), "marbles-dist-probe-"));
    try {
      const distLib = pathToFileURL(resolve(distDir, "lib.js")).href;
      const distEngine = pathToFileURL(resolve(distDir, "engine.js")).href;
      const dir = join(root, ".foundry", "marbles");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "main.ts"),
        `import { CommandError, step } from "@foundry.sh/marbles";
const boom = step("boom").exec("false");
const inner = step("inner").do(({ run }) => run.id);
export const check = step("check").do(async ({ run }) => {
  await import(${JSON.stringify(`${distLib}?copy=2`)});
  await import(${JSON.stringify(`${distEngine}?copy=2`)});
  const nestedRunId = await inner.run();
  let instanceofOk = false;
  try {
    await boom.run();
  } catch (error) {
    instanceofOk = error instanceof CommandError;
  }
  return {
    hasRunId: typeof run.id === "string" && run.id.length > 0,
    instanceofOk,
    nestedHasRunId: typeof nestedRunId === "string" && nestedRunId.length > 0,
  };
});
`
      );
      const home = testHome({ providers: false });
      const output = execFileSync(
        "node",
        [resolve(MARBLES_DIR, "dist/cli.js"), "trigger", "check"],
        { cwd: root, encoding: "utf8", env: home.env, timeout: 30_000 }
      );
      expect(output).toContain('"hasRunId": true');
      expect(output).toContain('"instanceofOk": true');
      expect(output).toContain('"nestedHasRunId": true');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 45_000);

  it("loads .ts workspaces on Node and Bun, handles symlinked CJS siblings, refuses local CJS, and detects loader adapters", async () => {
    expect(detectLoaderAdapter({ registerHooks: () => undefined })).toBe(
      "node"
    );
    expect(detectLoaderAdapter({ bunPlugin: () => undefined })).toBe("bun");
    expect(() => detectLoaderAdapter({})).toThrow(
      UnsupportedLoaderRuntimeError
    );

    const root = mkdtempSync(join(tmpdir(), "marbles-cross-runtime-"));
    try {
      const siblingDir = join(root, "packages", "sibling");
      const appDir = join(root, "app");
      const marblesDir = join(appDir, ".foundry", "marbles");
      const nodeModulesDir = join(appDir, "node_modules");
      mkdirSync(siblingDir, { recursive: true });
      mkdirSync(marblesDir, { recursive: true });
      mkdirSync(nodeModulesDir, { recursive: true });

      writeFileSync(
        join(siblingDir, "package.json"),
        JSON.stringify({
          main: "./index.js",
          name: "sibling",
          version: "1.0.0",
        })
      );
      writeFileSync(
        join(siblingDir, "index.js"),
        'module.exports = { label: "from-sibling" };\n'
      );
      symlinkSync(siblingDir, join(nodeModulesDir, "sibling"), "dir");

      writeFileSync(
        join(marblesDir, "_helper.ts"),
        "export const prefix = 'ok';\n"
      );
      writeFileSync(
        join(marblesDir, "main.ts"),
        `import { step } from "@foundry.sh/marbles";
import sibling from "sibling";
import { prefix } from "./_helper";
const privateHelper = step("private-helper").do(() => prefix);
export const check = step("check").do(async () => \`\${await privateHelper.run()}:\${sibling.label}\`);
`
      );

      const cjsFile = join(root, "bad.cjs");
      writeFileSync(cjsFile, "module.exports = {};\n");
      const session = await openLoadSession();
      try {
        await expect(session.importModule(cjsFile)).rejects.toThrow(
          CommonJsModuleError
        );
      } finally {
        session.dispose();
      }

      const printed: string[] = [];
      const home = testHome({ providers: false });
      await openWorkspace(
        {
          artifacts: home.layout.artifacts,
          config: marblesDir,
          dry: true,
          state: home.layout.state,
        },
        { print: (line) => printed.push(line) }
      );
      expect(printed.some((line) => line.includes("unexported"))).toBe(false);

      const distCli = resolve(MARBLES_DIR, "dist/cli.js");
      for (const runtime of ["node", "bun"] as const) {
        const runHome = testHome();
        const output = execFileSync(runtime, [distCli, "trigger", "check"], {
          cwd: appDir,
          encoding: "utf8",
          env: runHome.env,
          timeout: 30_000,
        });
        expect(output).toContain("ok:from-sibling");
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 60_000);
});
