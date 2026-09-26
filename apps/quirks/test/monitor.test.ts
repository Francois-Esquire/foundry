import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globToRegExp } from "@foundry/lib/glob";
import { monitor, step } from "@foundry/quirks";
import { WorkspaceSystem } from "@foundry/workspaces";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { unbound } from "~/lib/bindings";
import { catalog } from "~/lib/catalog";
import type { AnyDefinition } from "~/lib/definition";
import { createLog } from "~/lib/log";
import type { Catalogue } from "~/lib/managers/workspaces";
import { runs } from "~/lib/run-scope";
import type { Change, Fetch, MonitorContext, MonitorSpec } from "~/monitor";
import { detector } from "~/monitor";
import { isRecord, readJson } from "~/state/json";

import { launch } from "./helpers/launch";
import { monitorContext } from "./helpers/monitor";

const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SHA_256_HEX_PATTERN_2 = /^[0-9a-f]{64}$/;
const SOURCE_PATTERN = /source is required/;
const CADENCE_PATTERN = /cadence/;
const KEY_PATTERN = /^[a-z0-9-]+-[0-9a-f]{6}$/;
const WRAP_PATTERN = /wrap it in workflow/;

const catalogues: Catalogue[] = [];

afterEach(async () => {
  catalog.reset();
  runs.clear();
  await Promise.all(catalogues.splice(0).map((open) => open.closeAll()));
});

/** Bind a host over `root`: what a files detector needs to read the tree. */
function hostIn(root: string, state?: string) {
  const lines: string[] = [];
  const log = createLog((_level, message) => lines.push(message));
  const catalogue = new WorkspaceSystem().extend(directory(), git());
  catalogues.push(catalogue);
  catalog.bind({
    agents: () => unbound("agents"),
    artifacts: () => unbound("artifacts"),
    host: { catalogue, ...(state === undefined ? {} : { state }) },
    log,
    root,
    sandboxes: () => unbound("sandboxes"),
    workspaces: () => unbound("workspaces"),
  });
  return { context: monitorContext(log), lines };
}

function recorder() {
  const changes: Change[] = [];
  const contexts: MonitorContext[] = [];
  return {
    changes,
    contexts,
    handler: (context: MonitorContext) => {
      changes.push(context.change);
      contexts.push(context);
      return Promise.resolve(changes.length);
    },
  };
}

describe("glob", () => {
  it("matches ** across directories, * within one, and {a,b} alternatives", () => {
    const guides = globToRegExp("**/{CLAUDE,AGENTS}.md");
    expect(guides.test("CLAUDE.md")).toBe(true);
    expect(guides.test("packages/ui/AGENTS.md")).toBe(true);
    expect(guides.test("packages/ui/README.md")).toBe(false);

    const top = globToRegExp("*.md");
    expect(top.test("a.md")).toBe(true);
    expect(top.test("docs/a.md")).toBe(false);
    expect(globToRegExp("docs/**").test("docs/x/y.txt")).toBe(true);
    expect(globToRegExp("a,b").test("a,b")).toBe(true);
  });
});

describe("files detector", () => {
  const spec: MonitorSpec = { glob: "**/*.md", kind: "files" };

  it("reports everything added on the first tick, then only what moved", async () => {
    const root = mkdtempSync(join(tmpdir(), "quirks-mon-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.md"), "one\n");
    writeFileSync(join(root, "sub", "b.md"), "two\n");
    writeFileSync(join(root, "c.txt"), "ignored\n");
    const { context } = hostIn(root);
    const { changes, contexts, handler } = recorder();
    const detect = detector("m", spec, handler);

    await expect(detect(context)).resolves.toEqual({ changed: true });
    expect(changes[0]).toMatchObject({
      kind: "files",
      modified: [],
      removed: [],
    });
    expect(
      changes[0]?.kind === "files" && changes[0].added.map((f) => f.path)
    ).toEqual(["a.md", "sub/b.md"]);
    // The handler sees the diff as `files` beside the step context.
    expect(contexts[0]?.files).toBe(changes[0]);
    expect(contexts[0]?.input).toEqual({});
    expect(typeof contexts[0]?.log).toBe("function");

    await expect(detect(context)).resolves.toEqual({ changed: false });
    expect(changes).toHaveLength(1);

    writeFileSync(join(root, "a.md"), "one more\n");
    await detect(context);
    expect(changes[1]).toMatchObject({
      added: [],
      modified: [{ path: "a.md" }],
      removed: [],
    });

    rmSync(join(root, "sub", "b.md"));
    await detect(context);
    const removed = changes[2]?.kind === "files" ? changes[2].removed : [];
    expect(removed).toHaveLength(1);
    expect(removed[0]?.path).toBe("sub/b.md");
    expect(removed[0]?.checksum).toMatch(SHA_256_HEX_PATTERN);
  });

  it("round-trips its state through monitors/<name>.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "quirks-mon-"));
    const state = mkdtempSync(join(tmpdir(), "quirks-mon-state-"));
    writeFileSync(join(root, "a.md"), "one\n");

    const first = recorder();
    await detector("m", spec, first.handler)(hostIn(root, state).context);
    const stored = readJson(join(state, "monitors", "m.json"));
    const files =
      isRecord(stored) && isRecord(stored.files) ? stored.files : {};
    expect(files["a.md"]).toMatch(SHA_256_HEX_PATTERN_2);

    const second = recorder();
    const detect = detector("m", spec, second.handler);
    await expect(detect(hostIn(root, state).context)).resolves.toEqual({
      changed: false,
    });
    writeFileSync(join(root, "a.md"), "two\n");
    await detect(hostIn(root, state).context);
    expect(second.changes[0]).toMatchObject({ modified: [{ path: "a.md" }] });
  });

  it("ignores directories and links matching the file glob", async () => {
    const root = mkdtempSync(join(tmpdir(), "quirks-mon-"));
    try {
      mkdirSync(join(root, "empty.md"));
      writeFileSync(join(root, "a.md"), "one\n");
      symlinkSync("a.md", join(root, "link.md"));
      const { context } = hostIn(root);
      const { changes, handler } = recorder();
      const detect = detector("m", spec, handler);

      await expect(detect(context)).resolves.toEqual({ changed: true });
      expect(changes[0]).toEqual({
        added: [
          {
            checksum: expect.stringMatching(SHA_256_HEX_PATTERN),
            path: "a.md",
          },
        ],
        kind: "files",
        modified: [],
        removed: [],
      });
      rmSync(join(root, "empty.md"), { recursive: true });
      rmSync(join(root, "link.md"));
      await expect(detect(context)).resolves.toEqual({
        changed: false,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("runs as the registered step with an empty poll input", async () => {
    const root = mkdtempSync(join(tmpdir(), "quirks-mon-"));
    writeFileSync(join(root, "guide.md"), "one\n");
    const { changes, contexts, handler } = recorder();
    monitor("**/*.md").do(handler);
    hostIn(root);
    const [key] = [...catalog.monitors.keys()] as [string];
    const guides = catalog.definitions.get(key);
    if (!guides) {
      throw new Error("expected the detector step");
    }

    await expect(launch(guides)).resolves.toEqual({ changed: true });
    expect(changes[0]).toMatchObject({
      added: [{ path: "guide.md" }],
      kind: "files",
    });
    expect(contexts[0]?.input).toEqual({});
    expect(contexts[0]?.run.path).toEqual([key]);
    await expect(launch(guides)).resolves.toEqual({ changed: false });
  });

  it("asks the tick to start a locked node the handler returns", async () => {
    const root = mkdtempSync(join(tmpdir(), "quirks-mon-"));
    writeFileSync(join(root, "guide.md"), "one\n");
    const ship = step("ship")
      .input(z.object({ task: z.string() }))
      .do(({ input }) => input.task);
    monitor("**/*.md").do(({ files }) =>
      ship({}, { task: files?.added[0]?.path ?? "" })
    );
    hostIn(root);
    const [key] = [...catalog.monitors.keys()] as [string];
    const detect = catalog.definitions.get(key) as AnyDefinition;

    await expect(launch(detect)).resolves.toEqual({
      changed: true,
      launch: { input: { task: "guide.md" }, workflow: "ship" },
    });
  });

  it("refuses a tree with children from the handler", async () => {
    const root = mkdtempSync(join(tmpdir(), "quirks-mon-"));
    writeFileSync(join(root, "guide.md"), "one\n");
    const a = step("a").do(() => 1);
    const b = step("b")
      .input(z.object({ a: z.number() }))
      .do(({ input }) => input.a);
    monitor("**/*.md").do(() => b({ a: a({}) }));
    hostIn(root);
    const [key] = [...catalog.monitors.keys()] as [string];
    const detect = catalog.definitions.get(key) as AnyDefinition;
    await expect(launch(detect)).rejects.toThrow(WRAP_PATTERN);
  });
});

describe("http detector", () => {
  function stub(replies: (() => Response)[]) {
    const calls: RequestInit[] = [];
    const fetchImpl: Fetch = (_, init) => {
      calls.push(init);
      const next = replies.shift();
      if (!next) {
        throw new Error("no reply queued");
      }
      return Promise.resolve(next());
    };
    return { calls, fetch: fetchImpl };
  }
  const json =
    (value: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(value), { status });

  it("hands the body on first sight and on change only", async () => {
    const { fetch, calls } = stub([
      json({ tags: ["v1"] }),
      json({ tags: ["v1"] }),
      json({ tags: ["v1", "v2"] }),
    ]);
    const spec: MonitorSpec = {
      kind: "http",
      url: "https://example.test/releases",
    };
    const { context } = hostIn("/nowhere");
    const { changes, contexts, handler } = recorder();
    const detect = detector("r", spec, handler, { fetch });

    await expect(detect(context)).resolves.toEqual({ changed: true });
    expect(changes[0]).toEqual({
      current: { tags: ["v1"] },
      kind: "http",
      previous: undefined,
      status: 200,
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    // The handler can read the polled body again as a standard Response.
    await expect(contexts[0]?.response?.json()).resolves.toEqual({
      tags: ["v1"],
    });

    await expect(detect(context)).resolves.toEqual({ changed: false });

    await detect(context);
    expect(changes[1]).toMatchObject({
      current: { tags: ["v1", "v2"] },
      previous: { tags: ["v1"] },
    });
  });

  it("logs a failed poll and keeps the last state", async () => {
    const { fetch } = stub([
      json("a"),
      json("boom", 500),
      () => {
        throw new Error("offline");
      },
      json("a"),
    ]);
    const spec: MonitorSpec = { kind: "http", url: "https://example.test" };
    const { context, lines } = hostIn("/nowhere");
    const { changes, handler } = recorder();
    const detect = detector("r", spec, handler, { fetch });

    await detect(context);
    await expect(detect(context)).resolves.toEqual({ changed: false });
    await expect(detect(context)).resolves.toEqual({ changed: false });
    expect(lines).toEqual([
      "[monitor] r poll failed: Error: HTTP 500",
      "[monitor] r poll failed: Error: offline",
    ]);
    await expect(detect(context)).resolves.toEqual({ changed: false });
    expect(changes).toHaveLength(1);
  });
});

describe("monitor factory", () => {
  const handler = () => Promise.resolve(null);

  it("routes a glob to files and a URL to http, keyed by source", () => {
    monitor("**/CLAUDE.md").do(handler);
    monitor("https://example.test/releases").every("5m").do(handler);
    const [guides, releases] = [...catalog.monitors.keys()] as [string, string];
    expect(guides).toMatch(KEY_PATTERN);
    expect(guides.startsWith("claude-md-")).toBe(true);
    expect(catalog.monitors.get(guides)).toEqual({
      glob: "**/CLAUDE.md",
      kind: "files",
    });
    expect(catalog.monitors.get(releases)).toEqual({
      kind: "http",
      url: "https://example.test/releases",
    });
    expect(catalog.definitions.has(guides)).toBe(true);
    expect(catalog.schedules.get(guides)).toEqual({
      input: null,
      key: guides,
      kind: "monitor",
      label: "**/CLAUDE.md",
      trigger: { kind: "interval", ms: 60_000 },
      workflow: guides,
    });
    expect(catalog.schedules.get(releases)?.trigger).toEqual({
      kind: "interval",
      ms: 300_000,
    });
    // Detectors are internal: they never appear as launchable entries.
    expect(catalog.entries()).toEqual([]);
  });

  it("gives the same source a second key", () => {
    monitor("*.md").do(handler);
    monitor("*.md").do(handler);
    const keys = [...catalog.monitors.keys()];
    expect(keys[1]).toBe(`${keys[0] as string}-2`);
  });

  it("rejects an empty source and a bad cadence at registration", () => {
    expect(() => monitor(" ")).toThrow(SOURCE_PATTERN);
    expect(() => monitor("*.md").every("soon")).toThrow(CADENCE_PATTERN);
  });
});
