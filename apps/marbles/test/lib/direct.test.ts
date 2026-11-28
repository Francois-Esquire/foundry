import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainers } from "@foundry/sandbox/node";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createFakeDriver } from "@foundry/sandbox/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agent, artifact } from "~/authoring/resources";
import type { Engine } from "~/lib/engine";

import { testEngine } from "../helpers/engine";

const DISPOSED = /the engine was disposed/;

let root: string;
let engine: Engine | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "marbles-direct-")));
});

afterEach(async () => {
  await engine?.dispose();
  engine = undefined;
  await rm(root, { force: true, recursive: true });
});

describe("the managers on the engine", () => {
  it("reads the root workspace and loads another", async () => {
    await writeFile(join(root, "notes.md"), "hello");
    engine = testEngine({ root });

    expect(engine.workspaces.current.root).toBe(root);
    const files = await engine.workspaces.current.files();
    expect(files.map((file) => file.path)).toContain("notes.md");
    const loaded = await engine.workspaces.load({ path: root });
    expect(loaded.root).toBe(root);
  });

  it("opens an agent session in the root, a new one per call, in the engine's store", async () => {
    engine = testEngine({
      reply: ({ cwd, prompt }) => `${cwd}: ${prompt}`,
      root,
    });
    const reviewer = agent({ prompt: "Review." });

    const first = await engine.agents.session(reviewer);
    const second = await engine.agents.session(reviewer);
    const streamed: string[] = [];
    const reply = await first.generate("Look.", {
      onText: (delta) => streamed.push(delta),
    });

    expect(reply.text).toBe(`${root}: Review.\nLook.`);
    expect(streamed.join("")).toBe(reply.text);
    expect(second.ref.id).not.toBe(first.ref.id);
    const stored = await engine.sessions.getSession(first.ref.id);
    expect(stored?.parentSessionId).toBeNull();
    expect(engine.agents.sessions).toBe(engine.sessions);
  });

  it("stops a direct session's turns once the engine is disposed", async () => {
    engine = testEngine({ root });
    const session = await engine.agents.session(agent({ prompt: "Review." }));
    await engine.dispose();
    engine = undefined;

    await expect(session.generate("Look.")).rejects.toThrow(DISPOSED);
  });

  it("runs a definition and a monitor it is told about after it started", async () => {
    await writeFile(join(root, "notes.md"), "hello");
    engine = await testEngine({ root }).start();
    const seen: string[] = [];

    engine.define({ fn: () => "late", kind: "step", name: "late" });
    engine.monitor({
      handler: ({ files }) => {
        seen.push(...(files?.added.map((file) => file.path) ?? []));
      },
      key: "notes",
      source: { glob: "*.md", kind: "files" },
      trigger: { kind: "interval", ms: 60_000 },
    });

    await expect(engine.run<string>("late", {})).resolves.toBe("late");
    await expect(engine.run("notes", {})).resolves.toEqual({ changed: true });
    expect(seen).toEqual(["notes.md"]);
    expect((await engine.schedules()).map((schedule) => schedule.key)).toEqual([
      "notes",
    ]);
    expect(engine.definitions().map((entry) => entry.name)).toEqual(["late"]);
    await engine.stop();
  });

  it("adds a version to a declared artifact on every write", async () => {
    engine = testEngine({ root });
    const report = artifact({ name: "report", type: "text/markdown" });

    const one = await engine.artifacts.write(report, { "report.md": "one" });
    const two = await engine.artifacts.write(report, { "report.md": "two" });

    expect(two.artifactId).toBe(one.artifactId);
    expect(two.id).not.toBe(one.id);
  });

  it("starts a sandbox the caller closes, over the containers it was handed", async () => {
    const commands: string[][] = [];
    const containers = createContainers({
      driver: createFakeDriver({
        exec: (command) => {
          commands.push([...command]);
          return { exitCode: 0, stderr: "", stdout: "ok" };
        },
      }),
      instanceLabel: "direct",
      store: new MemoryContainerStore(),
    });
    engine = testEngine({ containers, root });

    const box = await engine.sandboxes.start({
      image: "docker.io/oven/bun:1-slim",
    });
    await expect(box.exec(["bun", "test"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok",
    });
    expect(commands).toEqual([["bun", "test"]]);
    await expect(engine.sandboxes.containers()).resolves.toBe(containers);
    const again = await engine.sandboxes.open(box.id);
    expect(again.id).toBe(box.id);
    await box.close();
  });
});
