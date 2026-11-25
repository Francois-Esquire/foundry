import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Catalog, catalog } from "~/authoring/catalog";
import { defineProvider } from "~/authoring/providers";
import { dispose, inLoad, loadInto } from "~/authoring/runtime";
import { initializeDatabase } from "~/database/open";
import { DatabaseProviderStore } from "~/database/providers";
import { stateDatabase } from "~/layout";
import { claudeCode } from "~/lib/providers/claude-code";
import { codex } from "~/lib/providers/codex";
import { vercel } from "~/lib/providers/vercel";
import { cliArgs } from "./helpers/cli";
import { testHome } from "./helpers/home";

const SRC = resolve("src");
const DEFINED_TWICE =
  /provider "vercel" already defined \(.*define-provider\.test\.ts:\d+\); second definition \(.*define-provider\.test\.ts:\d+\)/;
const roots: string[] = [];

afterEach(async () => {
  catalog.reset();
  await dispose();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function scratch(): Promise<string> {
  const root = realpathSync(
    await mkdtemp(join(tmpdir(), "marbles-define-provider-"))
  );
  roots.push(root);
  return root;
}

const CUSTOM = `const echo = defineProvider({
  catalog: () => [{ id: "echo", kind: "text", modelId: "echo" }],
  create: ({ id, models }) => ({
    provider: { available: true, id, languageModel: () => ({}), models: [...models], offline: false },
  }),
  id: "acme",
  label: "Acme",
  settings: { parse: (value) => value, safeParse: (value) => ({ data: value, success: true }) },
});
if (echo.id !== "acme") throw new Error("defineProvider returns the provider it was given");`;

const DEFINING = `import { step } from "@foundry.sh/marbles";
import { defineProvider } from "@foundry.sh/marbles/providers";
import { claudeCode } from "@foundry.sh/marbles/providers/claude-code";
import { vercel } from "@foundry.sh/marbles/providers/vercel";
defineProvider(vercel);
defineProvider(claudeCode);
defineProvider(claudeCode);
${CUSTOM}
step("build").do(() => "built");
`;

const PLAIN = `import { step } from "@foundry.sh/marbles";
step("build").do(() => "built");
`;

async function workspace(
  root: string,
  name: string,
  source: string
): Promise<{ readonly dir: string; readonly source: string }> {
  const dir = join(root, name);
  const bin = join(dir, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(dir, ".env.schema"), "MARBLES_TEST_VALUE=\n");
  const varlock = join(bin, "varlock");
  await writeFile(
    varlock,
    `#!/bin/sh\nprintf '{"MARBLES_TEST_VALUE":"${name}"}'\n`
  );
  chmodSync(varlock, 0o755);
  const file = join(dir, "marbles.ts");
  await writeFile(file, source);
  return { dir, source: file };
}

async function machineProviders(state: string): Promise<void> {
  const opened = await initializeDatabase(stateDatabase(state));
  try {
    await new DatabaseProviderStore({ database: opened.database }).update(
      undefined,
      () => ({
        machine: {
          providers: [
            { enabled: true, id: "claude-code", plugin: "claude-code" },
            { enabled: true, id: "codex", plugin: "codex" },
            { enabled: true, id: "pi", plugin: "pi" },
            {
              enabled: true,
              id: "vercel",
              plugin: "vercel",
              settings: {
                apiKey: "MARBLES_TEST_VERCEL_KEY",
                baseURL: "http://127.0.0.1:9",
              },
            },
            { enabled: true, id: "acme", plugin: "acme" },
          ],
          version: 1,
        },
      })
    );
  } finally {
    opened.close();
  }
}

async function inProcess(
  root: string,
  body: string
): Promise<Record<string, unknown>> {
  const script = join(root, `host-${String(Date.now())}.ts`);
  await writeFile(
    script,
    `const { HostedWorkspaces } = await import(${JSON.stringify(join(SRC, "workspace/hosted.ts"))});
const report = {};
const hosted = await HostedWorkspaces.open({
  artifacts: ${JSON.stringify(join(root, "artifacts"))},
  state: ${JSON.stringify(join(root, "state"))},
});
const problems = (host) =>
  Object.fromEntries(host.engine.providers.list().map((entry) => [entry.id, entry.problem ?? entry.state]));
const ready = (host) => host.engine.models.providers.filter((provider) => provider.available).map((provider) => provider.id);
try {
${body}
} finally {
  await hosted.close();
}
process.stdout.write(JSON.stringify(report) + "\\n");
process.exit(0);
`
  );
  const output = execFileSync(process.execPath, ["--no-env-file", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MARBLES_TEST_VERCEL_KEY: "key",
      PATH: "/usr/bin:/bin",
    },
    timeout: 90_000,
  });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
}

it("refuses a definition once the engine it would reach is built, and anything that is not a provider", async () => {
  expect(() => defineProvider({} as never)).toThrow(
    "defineProvider: pass a provider"
  );
  const { instanceRuntime } = await import("~/authoring/runtime");
  await instanceRuntime();
  expect(() => defineProvider(vercel)).toThrow(
    "a workspace's providers are fixed once its engine is built"
  );
});

const UNDEFINED_VERCEL =
  'provider "vercel" is unavailable: this workspace does not define it; to use it, add to the workspace\'s source: import { defineProvider } from "@foundry.sh/marbles/providers"; import { vercel } from "@foundry.sh/marbles/providers/vercel"; defineProvider(vercel);';
const UNDEFINED_PI =
  'provider "pi" is unavailable: this workspace does not define it; to use it, add to the workspace\'s source: import { defineProvider } from "@foundry.sh/marbles/providers"; import { pi } from "@foundry.sh/marbles/providers/pi"; defineProvider(pi);';
const UNDEFINED_ACME =
  'provider "acme" is unavailable: this workspace does not define it; to use it, pass its provider object to defineProvider, imported from "@foundry.sh/marbles/providers", in the workspace\'s source';

it("gives each workspace Claude Code, Codex and only the providers its own source defines, and forgets them when the call goes", async () => {
  const root = await scratch();
  await machineProviders(join(root, "state"));
  const alpha = await workspace(root, "alpha", DEFINING);
  const beta = await workspace(root, "beta", PLAIN);
  const report = await inProcess(
    root,
    `const registration = { config: ${JSON.stringify(alpha.source)}, root: ${JSON.stringify(alpha.dir)} };
  const first = await hosted.register(registration);
  const other = await hosted.register({ config: ${JSON.stringify(beta.source)}, root: ${JSON.stringify(beta.dir)} });
  report.alpha = problems(first);
  report.alphaReady = ready(first);
  report.acme = first.engine.models.resolve("text", "acme/echo").provider;
  report.beta = problems(other);
  report.betaReady = ready(other);
  await hosted.unregister(first.id);
  await Bun.write(${JSON.stringify(alpha.source)}, ${JSON.stringify(PLAIN)});
  const again = await hosted.register(registration);
  report.reloaded = problems(again);
  report.reloadedReady = ready(again);`
  );
  const alphaProblems = report.alpha as Record<string, string>;
  expect(alphaProblems.vercel).not.toContain("does not define");
  expect(alphaProblems.acme).toBe("ready");
  expect(alphaProblems.pi).toBe(UNDEFINED_PI);
  expect(report.alphaReady).toEqual(["acme"]);
  expect(report.acme).toBe("acme");
  expect(report.beta).toMatchObject({
    acme: UNDEFINED_ACME,
    pi: UNDEFINED_PI,
    vercel: UNDEFINED_VERCEL,
  });
  const betaProblems = report.beta as Record<string, string>;
  expect(betaProblems["claude-code"]).not.toContain("does not define");
  expect(betaProblems.codex).not.toContain("does not define");
  expect(report.betaReady).toEqual([]);
  expect(report.reloaded).toEqual(report.beta);
  expect(report.reloadedReady).toEqual([]);
}, 120_000);

const overlapping = (own: string, other: string, provider: string) =>
  `import { step } from "@foundry.sh/marbles";
import { defineProvider } from "@foundry.sh/marbles/providers";
import { ${provider} } from "@foundry.sh/marbles/providers/${provider}";
globalThis.${own} = true;
for (let tries = 0; tries < 200 && !globalThis.${other}; tries += 1) {
  await new Promise((settle) => setTimeout(settle, 10));
}
globalThis.overlapped = (globalThis.overlapped ?? 0) + (globalThis.${other} ? 1 : 0);
defineProvider(${provider});
step("build").do(() => "built");
`;

it("keeps the providers of two workspaces whose sources load at once apart", async () => {
  const root = await scratch();
  await machineProviders(join(root, "state"));
  const alpha = await workspace(
    root,
    "alpha",
    overlapping("alphaLoading", "betaLoading", "vercel")
  );
  const beta = await workspace(
    root,
    "beta",
    overlapping("betaLoading", "alphaLoading", "pi")
  );
  const report = await inProcess(
    root,
    `const [first, other] = await Promise.all([
    hosted.register({ config: ${JSON.stringify(alpha.source)}, root: ${JSON.stringify(alpha.dir)} }),
    hosted.register({ config: ${JSON.stringify(beta.source)}, root: ${JSON.stringify(beta.dir)} }),
  ]);
  report.overlapped = globalThis.overlapped;
  report.alpha = problems(first);
  report.beta = problems(other);`
  );
  expect(report.overlapped).toBe(2);
  const alphaProblems = report.alpha as Record<string, string>;
  const betaProblems = report.beta as Record<string, string>;
  expect(alphaProblems.vercel).not.toContain("does not define");
  expect(alphaProblems.pi).toBe(UNDEFINED_PI);
  expect(betaProblems.pi).not.toContain("does not define");
  expect(betaProblems.vercel).toBe(UNDEFINED_VERCEL);
}, 120_000);

let loads = 0;

async function loading(work: () => void): Promise<Catalog> {
  loads += 1;
  const into = new Catalog();
  await loadInto(`define-provider-${String(loads)}`, into, (load) =>
    Promise.resolve(inLoad(load, work))
  );
  return into;
}

it("refuses a provider defined twice, naming both places, and takes the defaults again harmlessly", async () => {
  const defaults = await loading(() => {
    expect(defineProvider(vercel)).toBe(vercel);
    defineProvider(claudeCode);
    defineProvider(claudeCode);
    defineProvider(codex);
    defineProvider(codex);
  });
  expect([...defaults.providers.keys()]).toEqual(["vercel"]);
  const twice = loading(() => {
    defineProvider(vercel);
    defineProvider(vercel);
  });
  await expect(twice).rejects.toThrow(DEFINED_TWICE);
  await expect(
    loading(() => {
      defineProvider(vercel);
      defineProvider({ ...vercel });
    })
  ).rejects.toThrow('provider "vercel" already defined');
  await expect(
    loading(() => {
      defineProvider({ ...codex });
    })
  ).rejects.toThrow('provider "codex" is one Marbles provides by default');
});

const ASKING = `import { agent, step } from "@foundry.sh/marbles";
const byId = agent({ name: "by-id", prompt: "Answer.", provider: "vercel" });
const byModel = agent({ name: "by-model", prompt: "Answer.", model: "vercel/vendor/chat" });
step("by-id").do(async ({ agents }) => (await (await agents.session(byId)).generate("Hi.")).text);
step("by-model").do(async ({ agents }) => (await (await agents.session(byModel)).generate("Hi.")).text);
`;

it("fails a run through the Marbles process that asks for a saved provider the workspace does not define, saying what to add", async () => {
  const root = await scratch();
  const home = testHome({ providers: false });
  const opened = await initializeDatabase(stateDatabase(home.layout.state));
  try {
    await new DatabaseProviderStore({ database: opened.database }).update(
      undefined,
      () => ({
        machine: {
          providers: [
            {
              enabled: true,
              id: "vercel",
              plugin: "vercel",
              settings: { apiKey: "MARBLES_TEST_VERCEL_KEY" },
            },
          ],
          version: 1,
        },
      })
    );
  } finally {
    opened.close();
  }
  const dir = join(root, "asking");
  await mkdir(join(dir, ".foundry", "marbles"), { recursive: true });
  await writeFile(join(dir, ".foundry", "marbles", "ask.ts"), ASKING);
  const roll = (name: string) => {
    const result = spawnSync(process.execPath, cliArgs("run", name), {
      cwd: dir,
      encoding: "utf8",
      env: { ...home.env, PATH: "/usr/bin:/bin" },
      timeout: 90_000,
    });
    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status,
    };
  };
  try {
    const byId = roll("by-id");
    expect(byId.status).not.toBe(0);
    expect(byId.output).toContain(`cannot use "vercel": ${UNDEFINED_VERCEL}`);
    const byModel = roll("by-model");
    expect(byModel.status).not.toBe(0);
    expect(byModel.output).toContain(
      `cannot use "vercel/vendor/chat": ${UNDEFINED_VERCEL}`
    );
  } finally {
    spawnSync(process.execPath, cliArgs("stop"), {
      cwd: dir,
      env: home.env,
      timeout: 30_000,
    });
  }
}, 180_000);
