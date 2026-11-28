import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { step, workflow } from "@foundry.sh/marbles";
import { afterAll, describe, expect, it } from "vitest";
import { dispose, setDefaultRuntime } from "~/authoring/runtime";
import { testEngine } from "./helpers/engine";
import { temporaryDirectory } from "./helpers/temporary";

const NO_NAME = /a key is matched by the definition's name/;
const NOT_A_STEP = /"script-flow" is a workflow, not a step/;
const SRC = resolve("src");

afterAll(async () => {
  await dispose();
});

describe("step.enqueue(name) in a script no workspace hosts", () => {
  it("launches what the script declared on the engine it starts, as the definition's own launch does", async () => {
    const leaf = step("script-leaf").do(() => "leaf");
    const flow = workflow("script-flow", () => leaf());
    const engine = testEngine({
      collect: { flow, leaf },
      pools: { default: { limit: 4 } },
      print: () => undefined,
    });
    setDefaultRuntime(() => Promise.resolve(engine));

    const launched = await step.enqueue<string>("script-leaf");
    await expect(launched.result).resolves.toBe("leaf");
    const flowed = await workflow.enqueue<string>("script-flow");
    await expect(flowed.result).resolves.toBe("leaf");
    expect(engine.executions.get(flowed.id)).toBeDefined();
    await expect(step.enqueue("script-flow")).rejects.toThrow(NOT_A_STEP);
    const keyed = await step.enqueue<string>("script-leaf", {}, { key: "k" });
    await expect(keyed.result).resolves.toBe("leaf");
    const same = await leaf.enqueue({}, { key: "k" });
    expect(same.id).toBe(keyed.id);

    const anonymous = step().do(() => "anon");
    await expect(anonymous.enqueue({}, { key: "k" })).rejects.toThrow(NO_NAME);
    const undeclared = step("undeclared-leaf").do(() => "nope");
    await expect(undeclared.enqueue({}, { key: "k" })).rejects.toThrow(NO_NAME);

    const parent = step("script-parent").do(async () => {
      const child = await step.enqueue<string>("script-leaf");
      const flowRun = await workflow.enqueue<string>("script-flow");
      return `${await child.result} and ${await flowRun.result}`;
    });
    await expect(parent.run()).resolves.toBe("leaf and leaf");
  });

  it("installs the default Node runtime when @foundry.sh/marbles/engine is imported in a standalone script", () => {
    const top = temporaryDirectory("marbles-standalone-engine-");
    const script = join(top, "standalone.ts");
    writeFileSync(
      script,
      `import { step } from ${JSON.stringify(resolve("dist/index.js"))};
import ${JSON.stringify(resolve("dist/engine.js"))};
const answer = step("standalone-answer").do(() => 42);
process.stdout.write(JSON.stringify(await answer.run()));
process.exit(0);
`
    );
    const output = execFileSync("node", [script], {
      cwd: top,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(JSON.parse(output)).toBe(42);
  });
});

const BUILD = `import { defineConfig, step, workflow } from "@foundry.sh/marbles";
export default defineConfig({ pools: { children: 1 }, pool: "children" });
export const build = step("build").do(({ input }) => {
  globalThis.bodies = (globalThis.bodies ?? 0) + 1;
  return \`built \${input.ref}\`;
});
export const ship = workflow("ship", () => build({}, { ref: "shipped" }));
`;

const DISPATCH = `import { defineConfig, step, workflow } from "@foundry.sh/marbles";
export default defineConfig({ pools: { default: 1 } });
export const dispatch = step("dispatch").do(async () => {
  const first = await step.enqueue("build", { ref: "main" }, { key: "k" });
  const again = await step.enqueue("build", { ref: "other" }, { key: "k" });
  const shipped = await workflow.enqueue("ship");
  const wrong = await workflow.enqueue("build").catch((error) => error.message);
  const built = await again.result;
  const shippedBuild = await shipped.result;
  return {
    bodies: globalThis.bodies,
    built,
    same: first.id === again.id,
    shipped: shippedBuild,
    wrong,
  };
});
`;

describe("step.enqueue(name) across a workspace's files", {
  timeout: 60_000,
}, () => {
  it("launches a definition another file declares, never importing it, with a key that matches across launches", () => {
    const top = temporaryDirectory("marbles-launch-by-name-");
    const root = join(top, "root");
    const source = join(root, "marbles");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "build.ts"), BUILD);
    writeFileSync(join(source, "dispatch.ts"), DISPATCH);
    const script = join(top, "host.ts");
    writeFileSync(
      script,
      `import { hostWorkspace } from ${JSON.stringify(join(SRC, "workspace/host.ts"))};
const host = await hostWorkspace({
  artifacts: ${JSON.stringify(join(top, "home", "artifacts"))},
  directory: ${JSON.stringify(root)},
  print: () => undefined,
  source: ${JSON.stringify(source)},
  state: ${JSON.stringify(join(top, "home", "marbles"))},
});
try {
  process.stdout.write(JSON.stringify(await host.engine.run("dispatch", {})));
} finally {
  await host.close();
}
process.exit(0);
`
    );
    const output = execFileSync("bun", ["--no-env-file", script], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(JSON.parse(output)).toEqual({
      bodies: 2,
      built: "built main",
      same: true,
      shipped: "built shipped",
      wrong:
        'workflow.enqueue("build"): "build" is a step, not a workflow; use step.enqueue("build")',
    });
  });
});
