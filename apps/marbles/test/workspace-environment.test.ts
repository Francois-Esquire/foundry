import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { testHome } from "./helpers/home";

const SRC = resolve("src");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

it("loads a workspace with a .env.schema file and runs it with the Marbles process's environment, starting no child process to load it", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-workspace-env-"));
  roots.push(root);
  const home = testHome({ providers: false });
  const dir = join(root, "workspace");
  await mkdir(dir);
  await writeFile(
    join(dir, ".env.schema"),
    "MARBLES_TEST_VALUE=from-schema\nMARBLES_TEST_SCHEMA_ONLY=from-schema\n"
  );
  const source = join(dir, "marbles.ts");
  await writeFile(
    source,
    `import { step } from "@foundry.sh/marbles";
export const read = step("read").do(async ({ exec }) => {
  const { stdout } = await exec(["sh", "-c", 'printf %s "$MARBLES_TEST_VALUE:$MARBLES_TEST_SCHEMA_ONLY"']);
  return stdout;
});
`
  );
  const script = join(root, "host.ts");
  await writeFile(
    script,
    `import { mock } from "bun:test";
const real = { ...(await import("node:child_process")) };
const started = [];
const wrapped = Object.fromEntries(
  ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"].map((name) => [
    name,
    (...args) => {
      const call = JSON.stringify(args.filter((arg) => typeof arg !== "function"));
      if (call.includes(${JSON.stringify(dir)})) {
        started.push(call);
      }
      return real[name](...args);
    },
  ])
);
mock.module("node:child_process", () => ({ ...real, ...wrapped, default: { ...real, ...wrapped } }));
const { hostEngine, openWorkspace } = await import(${JSON.stringify(join(SRC, "workspace/open.ts"))});
const { openHostDatabase } = await import(${JSON.stringify(join(SRC, "database/workspaces.ts"))});
const report = {};
const lines = [];
const args = {
  artifacts: ${JSON.stringify(home.layout.artifacts)},
  config: ${JSON.stringify(source)},
  dry: false,
  state: ${JSON.stringify(home.layout.state)},
};
const opened = await openWorkspace(args, { print: (line) => lines.push(line) });
report.started = [...started];
report.lines = [...lines];
const database = await openHostDatabase(args.state);
const engine = await hostEngine(args, opened, { database, print: () => undefined });
await engine.start();
try {
  report.read = await (await engine.launch("read", {})).result;
} finally {
  await engine.dispose();
  database.close();
}
process.stdout.write(JSON.stringify(report) + "\\n");
process.exit(0);
`
  );
  const output = execFileSync("bun", ["--no-env-file", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...home.env, MARBLES_TEST_VALUE: "from-process" },
    timeout: 60_000,
  });
  const report = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
  expect(report.started).toEqual([]);
  expect(report.lines).toEqual([`[source] ${source}`]);
  expect(report.read).toBe("from-process:");
}, 90_000);
