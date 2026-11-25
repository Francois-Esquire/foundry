import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isModuleDeclaration,
  isStringLiteral,
  type Node,
  ScriptTarget,
  SyntaxKind,
} from "typescript";
import { expect, test } from "vitest";
import { initializeDatabase } from "~/database/open";
import { DatabaseProviderStore } from "~/database/providers";
import { stateDatabase } from "~/layout";

import { fakeCodex } from "./helpers/codex";
import { testHome } from "./helpers/home";
import { rawMcpSession, strayLines } from "./helpers/mcp-stdio";
import { inspectDashboard } from "./helpers/terminal";

const QUEUED_RUN_ID = /^rn-\S+$/;
const CURRENT_GENERATION = /engine generation \d+: pid \d+ · current/;

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const SCOPE_MARK = /^@/;
const REQUIRE_CALLS = new Set(["require", "__require"]);
function loadsModule(callee: Node): boolean {
  return (
    callee.kind === SyntaxKind.ImportKeyword ||
    (isIdentifier(callee) && REQUIRE_CALLS.has(callee.text))
  );
}

function specifierOf(node: Node): Node | undefined {
  if (isImportDeclaration(node) || isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (
    isImportEqualsDeclaration(node) &&
    isExternalModuleReference(node.moduleReference)
  ) {
    return node.moduleReference.expression;
  }
  if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
    return node.argument.literal;
  }
  if (isModuleDeclaration(node)) {
    return node.name;
  }
  return isCallExpression(node) && loadsModule(node.expression)
    ? node.arguments[0]
    : undefined;
}

function moduleSpecifiers(source: string): string[] {
  const imports: string[] = [];
  function inspect(node: Node) {
    const specifier = specifierOf(node);
    if (specifier && isStringLiteral(specifier)) {
      imports.push(specifier.text);
    }
    forEachChild(node, inspect);
  }
  const file = createSourceFile(
    "package.ts",
    source,
    ScriptTarget.Latest,
    true
  );
  inspect(file);
  return [
    ...file.typeReferenceDirectives.map(({ fileName }) => fileName),
    ...imports,
  ];
}

function privateImports(source: string): string[] {
  return moduleSpecifiers(source).filter(
    (specifier) =>
      specifier.startsWith("@foundry/") || specifier.startsWith("~/")
  );
}

function importedPackages(source: string): string[] {
  return moduleSpecifiers(source).flatMap((specifier) => {
    if (specifier.startsWith(".") || specifier.startsWith("node:")) {
      return [];
    }
    const [scope = "", name = ""] = specifier.split("/");
    return [scope.startsWith("@") ? `${scope}/${name}` : scope];
  });
}

function undeclaredPackages(
  names: readonly string[],
  dependencies: Readonly<Record<string, string>>
): string[] {
  return names.filter(
    (name) =>
      !(
        Object.hasOwn(dependencies, name) ||
        Object.hasOwn(
          dependencies,
          `@types/${name.replace(SCOPE_MARK, "").replace("/", "__")}`
        )
      )
  );
}

test("package import inspection checks declarations and dynamic imports, not config source strings", () => {
  expect(
    privateImports(
      'import type { T } from "@foundry/private"; type X = import("@foundry/query").X; import("~/dynamic");'
    )
  ).toEqual(["@foundry/private", "@foundry/query", "~/dynamic"]);
  expect(
    privateImports('const config = `import { step } from "@foundry/private";`;')
  ).toEqual([]);
});

test("package import inspection names the package of every bare declaration import", () => {
  expect(
    importedPackages(
      "import { A } from '@fal-ai/client'; import 'drizzle-orm/sqlite-core'; import { B } from './chunk.js'; import { EventEmitter } from 'node:events'; type C = import(\"ai-sdk-provider-pi\").C;"
    )
  ).toEqual(["@fal-ai/client", "drizzle-orm", "ai-sdk-provider-pi"]);
  expect(
    importedPackages('/// <reference types="optional-package" />\nexport {};')
  ).toEqual(["optional-package"]);
  expect(
    importedPackages(
      'import SDK = require("@optional/package/sub");\nexport = SDK;'
    )
  ).toEqual(["@optional/package"]);
  expect(
    importedPackages(
      'export {};\ndeclare module "ai-sdk-provider-pi" { interface PiSettings { extra?: boolean } }\ndeclare namespace Local { const kept: string }'
    )
  ).toEqual(["ai-sdk-provider-pi"]);
  expect(
    moduleSpecifiers(
      'const a = require("@fal-ai/client"); const b = __require("@fal-ai/client/realtime"); const c = other("not-a-module");'
    )
  ).toEqual(["@fal-ai/client", "@fal-ai/client/realtime"]);
  expect(
    undeclaredPackages(["node", "@scope/typed", "zod", "optional-package"], {
      "@types/node": "^26.4.1",
      "@types/scope__typed": "1.0.0",
      zod: "^4.4.3",
    })
  ).toEqual(["optional-package"]);
});

const OPTIONAL_PROVIDER_SDKS = [
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/sdk",
  "ai-sdk-provider-claude-code",
  "ai-sdk-provider-codex-cli",
  "ai-sdk-provider-pi",
];

const PROVIDER_ENTRIES = [
  "providers/claude-code",
  "providers/codex",
  "providers/gateway",
  "providers/pi",
  "providers/vercel",
];

const OPT_IN_MODELS: Record<string, string> = {
  "providers/gateway": "function gatewayModels(",
  "providers/pi": "function piProvider(",
  "providers/vercel": "function vercelModels(",
};

const MODEL_FACTORY_ENTRIES = new Set(["engine", "lib"]);

const OPT_IN_MARKERS: Record<string, string> = {
  "providers/gateway": "OpenAI-compatible gateway",
  "providers/pi": "OPENCODE_API_KEY",
  "providers/vercel": "Vercel AI Gateway",
};

function distFiles(dist: string, directory = dist): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((each) => {
    const path = join(directory, each.name);
    if (each.isDirectory()) {
      return each.name === "migrations" ? [] : distFiles(dist, path);
    }
    return [relative(dist, path)];
  });
}

function staticGraph(dist: string, entry: string): string[] {
  const seen = new Set<string>();
  function visit(file: string) {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const source = createSourceFile(
      file,
      readFileSync(join(dist, file), "utf8"),
      ScriptTarget.Latest,
      true
    );
    for (const node of source.statements) {
      if (
        (isImportDeclaration(node) || isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      ) {
        visit(join(dirname(file), node.moduleSpecifier.text));
      }
    }
  }
  visit(entry);
  return [...seen];
}

function staticImports(dist: string, entry: string): string[] {
  const seen = new Set<string>();
  const specifiers = new Set<string>();
  function visit(file: string) {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const source = createSourceFile(
      file,
      readFileSync(join(dist, file), "utf8"),
      ScriptTarget.Latest,
      true
    );
    for (const node of source.statements) {
      if (
        (isImportDeclaration(node) || isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        isStringLiteral(node.moduleSpecifier)
      ) {
        const { text } = node.moduleSpecifier;
        if (text.startsWith(".")) {
          visit(join(dirname(file), text));
        } else {
          specifiers.add(text);
        }
      }
    }
  }
  visit(entry);
  return [...specifiers];
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      process.stderr.write(String(error.stdout));
    }
    throw error;
  }
}

test("the tarball installs and shares the library registry with the CLI", async () => {
  const consumer = mkdtempSync(join(tmpdir(), "marbles-package-"));
  const standalone = mkdtempSync(join(tmpdir(), "marbles-global-"));
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
        dependencies: {
          "@foundry.sh/marbles": `file:${archive}`,
          zod: "^4.4.3",
        },
        name: "marbles-package-consumer",
        private: true,
        type: "module",
      })
    );
    run("bun", ["install"], consumer);
    const installed = join(consumer, "node_modules/@foundry.sh/marbles");
    const manifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8")
    );
    expect(manifest.name).toBe("@foundry.sh/marbles");
    expect(manifest.private).toBe(false);
    expect(manifest.repository.directory).toBe("apps/marbles");
    expect(readFileSync(join(installed, "CHANGELOG.md"), "utf8")).toContain(
      manifest.version
    );
    expect(readFileSync(join(installed, "LICENSE"), "utf8")).toContain("MIT");
    expect(readFileSync(join(installed, "LICENSE.vendors"), "utf8")).toContain(
      "Copyright (c) 2026 Aniket Pawar"
    );
    expect(readdirSync(installed)).not.toContain("src");
    expect(
      readdirSync(join(installed, "dist", "migrations", "meta"))
    ).toContain("_journal.json");
    expect(
      Object.entries(manifest).filter(
        ([, value]) =>
          typeof value === "object" &&
          value !== null &&
          Object.hasOwn(value, "@fal-ai/client")
      ),
      "the manifest lists @fal-ai/client"
    ).toEqual([]);
    for (const file of distFiles(join(installed, "dist"))) {
      if (file.endsWith(".js") || file.endsWith(".d.ts")) {
        const source = readFileSync(join(installed, "dist", file), "utf8");
        expect(privateImports(source)).toEqual([]);
        expect(
          moduleSpecifiers(source).filter((specifier) =>
            specifier.startsWith("@fal-ai/")
          ),
          `${file} imports fal`
        ).toEqual([]);
      }
      if (file.endsWith(".d.ts")) {
        expect(
          undeclaredPackages(
            importedPackages(
              readFileSync(join(installed, "dist", file), "utf8")
            ),
            manifest.dependencies
          ),
          `${file} imports a package that is not a dependency`
        ).toEqual([]);
      }
    }
    writeFileSync(
      join(consumer, "marbles.config.ts"),
      `
import { step, workflow } from "@foundry.sh/marbles";
import { z } from "zod";
const named = z.object({ name: z.string() });
const greet = step("packed-greet").input(named).do(({ input }) => ({ greeting: \`Hello \${input.name}\` }));
export const packedWorkflow = workflow("packed-workflow").input(named).do(({ input }) => greet({}, { name: input.name }));
`
    );
    writeFileSync(
      join(consumer, "types.ts"),
      `
import { step } from "@foundry.sh/marbles";
import { z } from "zod";
step("typed").input(z.object({ text: z.string() })).do(({ input }) => input.text.length);
// @ts-expect-error Step names must be strings.
step(123);
`
    );
    writeFileSync(
      join(consumer, "host.ts"),
      `
import { packedWorkflow } from "./marbles.config";
import { step } from "@foundry.sh/marbles";
import { ArtifactManager, Engine, InMemoryArtifactStore, InMemorySessionStore, Models, WorkspaceSystem, directory, git, nodeObserver, piProvider } from "@foundry.sh/marbles/lib";
import { claimProcess, readProcess } from "@foundry.sh/marbles/process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const inventory = step("host-inventory").do(async ({ workspaces }) => (await workspaces.current.files()).length);
const root = ".";
const instances = {
  artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
  containers: () => Promise.reject(new Error("this host has no sandbox runtime")),
  models: new Models({ providers: [piProvider()] }),
  sessions: new InMemorySessionStore(),
  workspaces: new WorkspaceSystem().extend(directory({ observer: nodeObserver }), git()),
};
const engine = new Engine({ ...instances, root, workspaceId: "host" });
const stateDir = mkdtempSync(join(tmpdir(), "marbles-host-"));
const claim = claimProcess(stateDir, { config: null, host: "worker" });
if (readProcess(stateDir)?.pid !== process.pid) throw new Error("The host must hold its workspace");
if (instances.models.providers.find((provider) => provider.id === "pi")?.available) throw new Error("Unconfigured Pi must stay unavailable");
// @ts-expect-error An engine needs every instance.
new Engine({ root, workspaceId: "host" });
engine.define(packedWorkflow);
engine.define(inventory);
// The managers answer on the engine itself, before anything runs.
const direct = (await engine.workspaces.current.files()).some((file) => file.path === "host.ts");
await engine.start();
const greeted = await engine.run<{ greeting: string }>("packed-workflow", { name: "host" });
const files = await engine.run<number>("host-inventory", {});
const listed = engine.definitions().map((entry) => entry.name).join(",");
await engine.stop();
await engine.dispose();
claim.release();
if (readProcess(stateDir) !== undefined) throw new Error("Release must clear the claim");
console.log(greeted.greeting, files > 0 && direct ? "sees files" : "sees nothing", listed);
`
    );
    writeFileSync(
      join(consumer, "providers.ts"),
      `
import { defineProvider, type ProviderInstance, type ProviderPlugin, type ProviderSetup } from "@foundry.sh/marbles/providers";
import { claudeCode } from "@foundry.sh/marbles/providers/claude-code";
import { codex } from "@foundry.sh/marbles/providers/codex";
import { gateway } from "@foundry.sh/marbles/providers/gateway";
import { pi } from "@foundry.sh/marbles/providers/pi";
import { vercel } from "@foundry.sh/marbles/providers/vercel";
import { z } from "zod";
const settings = z.object({ region: z.string() });
function create({ id, models, settings: { region } }: ProviderSetup<z.infer<typeof settings>>): ProviderInstance {
  return { provider: { available: region !== "", id, languageModel: () => { throw new Error("offline"); }, models: [...models], offline: false } };
}
const acme: ProviderPlugin<z.infer<typeof settings>> = defineProvider({
  catalog: () => [{ id: "echo", kind: "text", modelId: "echo" }],
  create,
  id: "acme",
  label: "Acme",
  settings,
});
const all: readonly ProviderPlugin[] = [acme, claudeCode, codex, gateway, pi, vercel];
// @ts-expect-error A provider needs create().
defineProvider({ catalog: () => [], id: "broken", label: "Broken", settings });
console.log(all.length);
`
    );
    writeFileSync(
      join(consumer, "prompt.ts"),
      `
import { Prompt, prompts, ref } from "@foundry.sh/marbles";
const review: Prompt = prompts.claude\`/code-review, then ask \${ref.agent("reviewer")}.\`;
// Prompt is a class at run time too, as the declarations say.
console.log(String(review), "|", String(prompts.codex\`Use \${ref.skill("review")}\`), "|", review instanceof Prompt);
`
    );
    writeFileSync(
      join(consumer, "embedded.ts"),
      `
import { Tasks } from "@foundry.sh/marbles";
import { ArtifactManager, Engine, InMemoryArtifactStore, InMemorySessionStore, Models, Sessions } from "@foundry.sh/marbles/engine";
import type { SessionStore, SessionStoreWrite } from "@foundry.sh/marbles/engine";
import { openWorkspaceRecords, type WorkspaceRecords } from "@foundry.sh/marbles/workspace";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A host can wrap the store it hands the engine and still write sessions.
const inner = new InMemorySessionStore();
const sessions: SessionStore = {
  commit: (write: SessionStoreWrite) => inner.commit(write),
  getMessage: (id) => inner.getMessage(id),
  getSession: (id) => inner.getSession(id),
  listMessages: (sessionId) => inner.listMessages(sessionId),
  // Forwarded, so writes from two Sessions over this store still exclude each other.
  transaction: (work) => inner.transaction(work),
};
const written = new Sessions({ store: sessions });
await written.createSession({ id: "host" });
await written.appendMessage({ parts: [{ text: "hi", type: "text" }], role: "user", sessionId: "host" });
const engine = new Engine({
  artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
  containers: () => Promise.reject(new Error("this host has no sandbox runtime")),
  models: new Models(),
  pools: { system: { limit: Number.POSITIVE_INFINITY } },
  root: ".",
  sessions,
  workspaceId: "embedded",
});
engine.task<{ n: number }, number>({
  name: "host-save",
  pool: "system",
  run: (input, context) => {
    context.observe({ kind: "result", type: "save" });
    return input.n + 1;
  },
});
await engine.start();
const value = await engine.run<number>("host-save", { n: 1 });
const [recorded] = engine.executions.list();
await engine.dispose();
console.log("embedded", value, recorded?.pool, recorded?.status, recorded?.observations.length);
// Given a state dir, the engine keeps its tasks across a dispose, in the
// Marbles database it opens there; a host may hand in its own records.
const state = mkdtempSync(join(tmpdir(), "marbles-embedded-"));
const persisted = () => new Engine({
  artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
  containers: () => Promise.reject(new Error("this host has no sandbox runtime")),
  models: new Models(),
  root: ".",
  sessions: new InMemorySessionStore(),
  state,
  workspaceId: "embedded",
});
const writer = persisted();
const created = await new Tasks({ store: writer.taskStore }).create({ title: "Kept across a dispose" });
await writer.dispose();
const reader = persisted();
const kept = await new Tasks({ store: reader.taskStore }).get(created.id);
await reader.dispose();
const stateRoot = mkdtempSync(join(tmpdir(), "marbles-records-"));
const records: WorkspaceRecords = openWorkspaceRecords({ state: stateRoot, workspaceId: "own" });
const own = new Engine({
  artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
  containers: () => Promise.reject(new Error("this host has no sandbox runtime")),
  models: new Models(),
  records,
  root: ".",
  sessions: new InMemorySessionStore(),
  workspaceId: "own",
});
await new Tasks({ store: own.taskStore }).create({ title: "In the host's records" });
await own.dispose();
console.log("persisted", kept?.title, existsSync(join(state, "marbles.db")), existsSync(join(stateRoot, "marbles.db")));
console.log("host sessions", (await sessions.listMessages("host")).length, typeof sessions.transaction);
`
    );
    for (const sdk of OPTIONAL_PROVIDER_SDKS) {
      expect(manifest.dependencies).not.toHaveProperty(sdk);
      expect(manifest.optionalDependencies).toHaveProperty(sdk);
    }
    const entries = [
      "cli",
      "engine",
      "generation",
      "index",
      "lib",
      "prebuilt",
      "process",
      "providers",
      "workspace",
    ];
    for (const entry of [...entries, ...PROVIDER_ENTRIES]) {
      expect(
        staticImports(join(installed, "dist"), `${entry}.js`).filter(
          (specifier) => OPTIONAL_PROVIDER_SDKS.includes(specifier)
        ),
        `${entry} eagerly imports an optional provider SDK`
      ).toEqual([]);
    }
    expect(staticImports(join(installed, "dist"), "statuses.js")).toEqual([]);
    const graphText = (entry: string) =>
      staticGraph(join(installed, "dist"), `${entry}.js`)
        .map((file) => readFileSync(join(installed, "dist", file), "utf8"))
        .join("\n");
    for (const [provider, marker] of Object.entries(OPT_IN_MODELS)) {
      expect(graphText(provider)).toContain(marker);
      for (const entry of [...entries, ...PROVIDER_ENTRIES].filter(
        (each) => each !== provider && !MODEL_FACTORY_ENTRIES.has(each)
      )) {
        expect(
          graphText(entry).includes(marker),
          `${entry} imports the models behind ${provider}`
        ).toBe(false);
      }
    }
    for (const [provider, marker] of Object.entries(OPT_IN_MARKERS)) {
      expect(graphText(provider), `${provider} holds its provider`).toContain(
        marker
      );
      for (const entry of [...entries, ...PROVIDER_ENTRIES]) {
        if (entry !== provider) {
          expect(
            graphText(entry).includes(marker),
            `${entry} imports ${provider}`
          ).toBe(false);
        }
      }
    }
    run(
      "bun",
      [
        resolve(PACKAGE_ROOT, "../../node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "esnext",
        "--module",
        "preserve",
        "--moduleResolution",
        "bundler",
        "types.ts",
        "host.ts",
        "embedded.ts",
        "prompt.ts",
        "providers.ts",
      ],
      consumer
    );
    expect(run("bun", ["prompt.ts"], consumer)).toContain(
      '/code-review, then ask @"reviewer (agent)". | Use $review | true'
    );
    expect(run("bun", ["host.ts"], consumer)).toContain(
      "Hello host sees files packed-workflow,host-inventory"
    );
    const embedded = run("bun", ["embedded.ts"], consumer);
    expect(embedded).toContain("embedded 2 system complete 1");
    expect(embedded).toContain("persisted Kept across a dispose true true");
    expect(embedded).toContain("host sessions 1 function");
    const cli = join(consumer, "node_modules/.bin/marbles");
    const terminal = await inspectDashboard(cli, consumer, []);
    expect(terminal.code).toBe(0);
    expect(terminal.output).toContain("Triggers");
    expect(terminal.output).toContain("Runs");
    expect(run(cli, ["--help"], consumer)).toContain(
      "programmable workspace automation"
    );
    writeFileSync(join(consumer, ".env"), "MARBLES_PACKAGE_PROBE=dotenv\n");
    expect(run("bunx", ["--bun", "marbles", "--help"], consumer)).toContain(
      "programmable workspace automation"
    );
    expect(() =>
      execFileSync("bun", [cli, "--help"], { cwd: consumer, stdio: "pipe" })
    ).toThrow("Bun loaded .env");
    rmSync(join(consumer, ".env"));
    expect(run(cli, ["list", "--dry-run"], consumer)).toContain(
      "[workflow] packed-workflow"
    );
    expect(
      run(
        cli,
        [
          "run",
          "packed-workflow",
          "--dry-run",
          "--input",
          '{"name":"tarball"}',
        ],
        consumer
      )
    ).toContain("Hello tarball");
    const home = testHome();
    const { state } = home.layout;
    const marbles = (args: string[], env = home.env) =>
      run(cli, args, consumer, env);
    try {
      expect(
        marbles(["run", "packed-workflow", "--input", '{"name":"daemon"}'])
      ).toContain("Hello daemon");
      const queued = marbles([
        "enqueue",
        "packed-workflow",
        "--input",
        '{"name":"queue"}',
        "--key",
        "packed",
      ]).trim();
      expect(queued).toMatch(QUEUED_RUN_ID);
      expect(marbles(["watch", queued])).toContain("Hello queue");
      expect(
        marbles(["enqueue", "packed-workflow", "--key", "packed"]).trim()
      ).toBe(queued);
      const status = marbles(["status"]);
      expect(status).toContain("marbles process: pid");
      expect(status).toContain("(generation)");
      expect(status).toMatch(CURRENT_GENERATION);
      expect(readdirSync(state)).toContain("marbles.db");
      expect(status).toContain(consumer);
      expect(marbles(["tasks", "create", "Through the generation"])).toContain(
        "Through the generation"
      );
    } finally {
      expect(marbles(["daemon", "stop"])).toContain("stopped Marbles process");
    }
    expect(marbles(["status"])).toContain(consumer);
    const listedTasks = (env: Record<string, string>) =>
      (
        JSON.parse(marbles(["tasks", "list", "--json"], env)).items as {
          title: string;
        }[]
      ).map((task) => task.title);
    expect(listedTasks(home.env)).toEqual(["Through the generation"]);
    const tasksHome = testHome();
    expect(marbles(["tasks", "create", "Packed"], tasksHome.env)).toContain(
      "Packed"
    );
    expect(readdirSync(tasksHome.layout.state)).toContain("marbles.db");
    expect(listedTasks(tasksHome.env)).toEqual(["Packed"]);
    const mcpHome = testHome();
    const session = await rawMcpSession(
      cli,
      ["mcp", "--source", join(consumer, "marbles.config.ts")],
      { cwd: consumer, env: mcpHome.env }
    );
    const listed = await session.request("tools/list");
    const ended = await session.close();
    expect(ended.code, ended.stderr).toBe(0);
    expect(listed).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "enqueue_workflow" }),
          expect.objectContaining({ name: "list" }),
        ]),
      },
    });
    expect(strayLines(ended.stdout)).toEqual([]);
    expect(marbles(["daemon", "stop"], mcpHome.env)).toContain(
      "no Marbles process is running"
    );
    writeFileSync(join(standalone, "workspace-marker.txt"), "workspace root");
    const authoring = join(standalone, ".foundry", "marbles");
    mkdirSync(authoring, { recursive: true });
    writeFileSync(
      join(authoring, "inventory.ts"),
      `
import { step } from "@foundry.sh/marbles";

step("inventory").do(async ({ workspaces }) => ({ paths: (await workspaces.current.files()).map((file) => file.path) }));
`
    );
    expect(run(cli, ["list", "--dry-run"], standalone)).toContain("inventory");
    const inventory = execFileSync(cli, ["run", "inventory", "--dry-run"], {
      cwd: standalone,
      encoding: "utf8",
      env: { ...process.env, PATH: dirname(process.execPath) },
      timeout: 30_000,
    });
    expect(inventory).toContain("workspace-marker.txt");
    const providersHome = testHome();
    const machine = await initializeDatabase(
      stateDatabase(providersHome.layout.state)
    );
    try {
      await new DatabaseProviderStore({ database: machine.database }).update(
        undefined,
        () => ({
          machine: {
            providers: [
              {
                enabled: true,
                id: "vercel",
                plugin: "vercel",
                settings: {
                  apiKey: "MARBLES_PACKAGE_VERCEL_KEY",
                  baseURL: "http://127.0.0.1:9",
                },
              },
            ],
            version: 1,
          },
        })
      );
    } finally {
      machine.close();
    }
    const rolled = () => {
      const result = spawnSync(cli, ["run", "inventory", "--dry-run"], {
        cwd: standalone,
        encoding: "utf8",
        env: {
          ...providersHome.env,
          MARBLES_PACKAGE_VERCEL_KEY: "key",
          PATH: dirname(process.execPath),
        },
        timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
      return `${result.stdout}${result.stderr}`;
    };
    const undefinedVercel =
      'provider "vercel" is unavailable: this workspace does not define it';
    expect(rolled()).toContain(undefinedVercel);
    writeFileSync(
      join(authoring, "providers.ts"),
      `
import { defineProvider } from "@foundry.sh/marbles/providers";
import { claudeCode } from "@foundry.sh/marbles/providers/claude-code";
import { vercel } from "@foundry.sh/marbles/providers/vercel";

defineProvider(claudeCode);
if (defineProvider(vercel) !== vercel) throw new Error("defineProvider returns its provider");
`
    );
    const defined = rolled();
    expect(defined).not.toContain(undefinedVercel);
    expect(defined).toContain('"vercel" has no models');
    expect(defined).toContain("workspace-marker.txt");
    rmSync(join(authoring, "providers.ts"));
    for (const directory of [consumer, standalone]) {
      const config =
        directory === standalone
          ? join(authoring, "inventory.ts")
          : join(directory, "marbles.config.ts");
      writeFileSync(config, 'import "@foundry.sh/marbles/prebuilt";');
      expect(run(cli, ["list", "--dry-run"], directory)).not.toContain(
        "[step]"
      );
      writeFileSync(
        config,
        'import { summarizeCodebase } from "@foundry.sh/marbles/prebuilt"; summarizeCodebase({ name: "packed-summary" });'
      );
      expect(
        run(cli, ["list", "--dry-run"], directory)
          .split("\n")
          .filter((line) => line.startsWith("[step]"))
      ).toEqual(["[step] packed-summary"]);
      const bin = join(directory, "bin");
      mkdirSync(bin);
      fakeCodex(bin);
      const result = execFileSync(cli, ["run", "packed-summary", "--dry-run"], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}` },
        timeout: 10_000,
      });
      expect(result).toContain("[run] packed-summary complete");
      expect(result).toContain("Summarize this codebase");
    }
    for (const sdk of OPTIONAL_PROVIDER_SDKS) {
      rmSync(join(consumer, "node_modules", sdk), {
        force: true,
        recursive: true,
      });
    }
    const optionalFreeHome = testHome();
    expect(
      run(
        "bun",
        ["--no-install", cli, "list", "--dry-run"],
        consumer,
        optionalFreeHome.env
      )
    ).toContain("[step] packed-summary");
  } finally {
    rmSync(standalone, { force: true, recursive: true });
    rmSync(consumer, { force: true, recursive: true });
  }
}, 180_000);
