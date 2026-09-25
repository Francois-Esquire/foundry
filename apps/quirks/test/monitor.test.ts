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

import { unbound } from "~/lib/bindings";
import { catalog } from "~/lib/catalog";
import { createLog } from "~/lib/log";
import type { Catalogue } from "~/lib/managers/workspaces";
import { runs } from "~/lib/run-scope";
import type { Change, Fetch, MonitorContext, MonitorSpec } from "~/monitor";
import { detector, resolveMonitor } from "~/monitor";
import { isRecord, readJson } from "~/state/json";

import { launch } from "./helpers/launch";
import { monitorContext } from "./helpers/monitor";

const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SHA_256_HEX_PATTERN_2 = /^[0-9a-f]{64}$/;
const ALREADY_REGISTERED_PATTERN = /already registered/;

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

    await expect(detect(context)).resolves.toEqual({
      changed: true,
      handled: 1,
    });
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

      await expect(detect(context)).resolves.toEqual({
        changed: true,
        handled: 1,
      });
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
    monitor("guides", handler, "**/*.md");
    hostIn(root);
    const guides = catalog.definitions.get("guides");
    if (!guides) {
      throw new Error("expected the detector step");
    }

    await expect(launch(guides)).resolves.toEqual({
      changed: true,
      handled: 1,
    });
    expect(changes[0]).toMatchObject({
      added: [{ path: "guide.md" }],
      kind: "files",
    });
    expect(contexts[0]?.input).toEqual({});
    expect(contexts[0]?.run.path).toEqual(["guides"]);
    await expect(launch(guides)).resolves.toEqual({ changed: false });
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

  it("hands the selected value on first sight and on change only", async () => {
    const { fetch, calls } = stub([
      json({ seen: 1, tags: ["v1"] }),
      json({ seen: 2, tags: ["v1"] }),
      json({ seen: 3, tags: ["v1", "v2"] }),
    ]);
    const spec: MonitorSpec = {
      headers: { Authorization: "Bearer x" },
      kind: "http",
      select: (body) =>
        typeof body === "object" && body !== null && "tags" in body
          ? body.tags
          : body,
      url: "https://example.test/releases",
    };
    const { context } = hostIn("/nowhere");
    const { changes, contexts, handler } = recorder();
    const detect = detector("r", spec, handler, { fetch });

    await expect(detect(context)).resolves.toEqual({
      changed: true,
      handled: 1,
    });
    expect(changes[0]).toEqual({
      current: ["v1"],
      kind: "http",
      previous: undefined,
      status: 200,
    });
    expect(calls[0]?.headers).toEqual({ Authorization: "Bearer x" });
    // The handler can read the polled body again as a standard Response.
    await expect(contexts[0]?.response?.json()).resolves.toEqual({
      seen: 1,
      tags: ["v1"],
    });

    await expect(detect(context)).resolves.toEqual({ changed: false });

    await detect(context);
    expect(changes[1]).toMatchObject({
      current: ["v1", "v2"],
      previous: ["v1"],
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

  it("routes a glob to files and a URL to http, one step and one schedule each", () => {
    monitor("guides", handler, "**/CLAUDE.md");
    monitor("releases", handler, "https://example.test/releases");
    expect(catalog.monitors.get("guides")).toEqual({
      glob: "**/CLAUDE.md",
      kind: "files",
    });
    expect(catalog.monitors.get("releases")).toEqual({
      kind: "http",
      url: "https://example.test/releases",
    });
    expect(catalog.definitions.has("guides")).toBe(true);
    expect(catalog.schedules.get("guides")).toMatchObject({
      input: null,
      kind: "monitor",
      trigger: { kind: "interval", ms: 60_000 },
      workflow: "guides",
    });
    // Detectors are internal: they never appear as launchable entries.
    expect(catalog.entries()).toEqual([]);
  });

  it("takes the object forms with their cadence", () => {
    monitor("a", handler, { every: "30s", glob: "*.md" });
    monitor("b", handler, { every: { hour: 9 }, url: "https://x.test" });
    expect(catalog.schedules.get("a")?.trigger).toEqual({
      kind: "interval",
      ms: 30_000,
    });
    expect(catalog.schedules.get("b")?.trigger).toEqual({
      kind: "calendar",
      slot: { hour: 9, minute: 0 },
    });
  });

  it("routes ws(s) to a live-only ws monitor, string or object", () => {
    expect(resolveMonitor("wss://x.test")).toEqual({
      kind: "ws",
      url: "wss://x.test",
    });
    expect(resolveMonitor({ send: "hi", url: "ws://x.test" })).toEqual({
      kind: "ws",
      send: "hi",
      url: "ws://x.test",
    });
    monitor("w", handler, "ws://x.test");
    expect(catalog.schedules.get("w")).toMatchObject({
      kind: "monitor",
      trigger: { kind: "interval", ms: 60_000 },
    });
  });

  it("refuses a taken name", () => {
    step("taken").do(() => null);
    expect(() => {
      monitor("taken", handler, "*.md");
    }).toThrow(ALREADY_REGISTERED_PATTERN);
    expect(catalog.schedules.has("taken")).toBe(false);
  });
});
