import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { initializeDatabase } from "~/database/open";
import { Engine } from "~/entries/engine";
import { Engine as LibEntryEngine } from "~/entries/lib";
import { stateDatabase } from "~/layout";
import { testInstances } from "./helpers/engine";
import { temporaryDirectory } from "./helpers/temporary";
import { snapshotTrees } from "./helpers/tree-snapshot";

const SOURCE = `import { step } from "@foundry.sh/marbles";
export const hello = step("hello").do(() => "ran");
`;

function machine() {
  const top = temporaryDirectory("marbles-dry-entry-");
  const root = join(top, "root");
  mkdirSync(root);
  writeFileSync(join(root, "marbles.ts"), SOURCE);
  const spawned = join(top, "spawned");
  mkdirSync(spawned);
  writeFileSync(join(spawned, "1.json"), "{}\n");
  return {
    artifacts: join(top, "home", "artifacts"),
    root,
    spawned,
    state: join(top, "home", "marbles"),
    top,
  };
}

const print = (): undefined => undefined;

const SRC = resolve("src");

function hostedBy(body: string, paths: ReturnType<typeof machine>): void {
  const script = join(paths.top, "..", `host-${String(Date.now())}.ts`);
  writeFileSync(
    script,
    `const paths = ${JSON.stringify(paths)};
${body}
process.exit(0);
`
  );
  execFileSync("bun", ["--no-env-file", script], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("an engine built under dry", { timeout: 60_000 }, () => {
  it.each([
    ["@foundry.sh/marbles/engine", Engine],
    ["@foundry.sh/marbles/lib", LibEntryEngine],
  ])(
    "writes nothing under its state directory, built from %s",
    async (_entry, Built) => {
      const { root, spawned, state, top } = machine();
      const before = snapshotTrees([top]);
      const engine = new Built({
        ...testInstances({ root }),
        dry: true,
        home: root,
        print,
        root,
        spawned,
        state: join(state, "one"),
        workspaceId: "one",
      });
      await engine.start();
      engine.define({ fn: () => "ran", kind: "step", name: "hello" });
      await engine.run("hello", {});
      expect(engine.state).toBeUndefined();
      await engine.dispose();
      expect(snapshotTrees([top])).toEqual(before);
    }
  );

  it("writes nothing through createEngine, the database it is handed included", async () => {
    const { artifacts, root, spawned, state, top } = machine();
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      const ignored = new Set([`${stateDatabase(state)}-shm`]);
      const before = snapshotTrees([top], ignored);
      const engine = createEngine({
        artifacts,
        catalog: new Catalog(),
        database: opened.database,
        dry: true,
        print,
        providers: [],
        root,
        spawned,
        stateDir: join(state, "one"),
        stateRoot: state,
        workspaceId: "one",
      });
      await engine.start();
      engine.define({ fn: () => "ran", kind: "step", name: "hello" });
      await engine.run("hello", {});
      await engine.dispose();
      expect(snapshotTrees([top], ignored)).toEqual(before);
    } finally {
      opened.close();
    }
  });

  it("writes nothing through hostWorkspace", () => {
    const paths = machine();
    const before = snapshotTrees([paths.top]);
    hostedBy(
      `import { hostWorkspace } from ${JSON.stringify(join(SRC, "workspace/host.ts"))};
const host = await hostWorkspace({
  artifacts: paths.artifacts,
  directory: paths.root,
  dry: true,
  print: () => undefined,
  source: paths.root + "/marbles.ts",
  state: paths.state,
});
try {
  await host.engine.run("hello", {});
} finally {
  await host.close();
}`,
      paths
    );
    expect(snapshotTrees([paths.top])).toEqual(before);
  });

  it("writes nothing through HostedWorkspaces, as a generation started with --dry-run hosts", () => {
    const paths = machine();
    const before = snapshotTrees([paths.top]);
    hostedBy(
      `import { HostedWorkspaces } from ${JSON.stringify(join(SRC, "workspace/hosted.ts"))};
const hosted = await HostedWorkspaces.open({
  artifacts: paths.artifacts,
  dry: true,
  state: paths.state,
});
try {
  const host = await hosted.register({ config: paths.root + "/marbles.ts", root: paths.root });
  await host.engine.run("hello", {});
} finally {
  await hosted.close();
}`,
      paths
    );
    expect(snapshotTrees([paths.top])).toEqual(before);
  });
});
