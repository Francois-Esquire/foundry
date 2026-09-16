import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitor, step } from "@foundry/quirks";
import { directory, WorkspaceSystem } from "@foundry/workspaces";
import { git } from "@foundry/workspaces/git";
import { afterEach, describe, expect, it } from "vitest";

import type { Primitives } from "~/lib/registry";
import { registry } from "~/lib/registry";
import type { Change, Fetch, MonitorSpec } from "~/monitor";
import { detector, globToRegExp, resolveMonitor } from "~/monitor";
import { isRecord, readJson } from "~/state/json";

afterEach(() => {
  registry.reset();
});

function primitivesIn(root: string, state?: string) {
  const lines: string[] = [];
  const primitives: Primitives = {
    log: (line: string) => lines.push(line),
    state,
    workspace: { root },
    workspaces: { system: new WorkspaceSystem().extend(directory(), git()) },
  } as never;
  return { lines, primitives };
}

function recorder() {
  const changes: Change[] = [];
  return {
    changes,
    handler: (_: Primitives, change: Change) => {
      changes.push(change);
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
    const { primitives } = primitivesIn(root);
    const { changes, handler } = recorder();
    const detect = detector("m", spec, handler);

    await expect(detect(primitives, null)).resolves.toEqual({
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

    await expect(detect(primitives, null)).resolves.toEqual({ changed: false });
    expect(changes).toHaveLength(1);

    writeFileSync(join(root, "a.md"), "one more\n");
    await detect(primitives, null);
    expect(changes[1]).toMatchObject({
      added: [],
      modified: [{ path: "a.md" }],
      removed: [],
    });

    rmSync(join(root, "sub", "b.md"));
    await detect(primitives, null);
    const removed = changes[2]?.kind === "files" ? changes[2].removed : [];
    expect(removed).toHaveLength(1);
    expect(removed[0]?.path).toBe("sub/b.md");
    expect(removed[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips its state through monitors/<name>.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "quirks-mon-"));
    const state = mkdtempSync(join(tmpdir(), "quirks-mon-state-"));
    writeFileSync(join(root, "a.md"), "one\n");

    const first = recorder();
    await detector(
      "m",
      spec,
      first.handler
    )(primitivesIn(root, state).primitives, null);
    const stored = readJson(join(state, "monitors", "m.json"));
    const files =
      isRecord(stored) && isRecord(stored.files) ? stored.files : {};
    expect(files["a.md"]).toMatch(/^[0-9a-f]{64}$/);

    const second = recorder();
    const detect = detector("m", spec, second.handler);
    await expect(
      detect(primitivesIn(root, state).primitives, null)
    ).resolves.toEqual({ changed: false });
    writeFileSync(join(root, "a.md"), "two\n");
    await detect(primitivesIn(root, state).primitives, null);
    expect(second.changes[0]).toMatchObject({ modified: [{ path: "a.md" }] });
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
    const { primitives } = primitivesIn("/nowhere");
    const { changes, handler } = recorder();
    const detect = detector("r", spec, handler, { fetch });

    await expect(detect(primitives, null)).resolves.toEqual({
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

    await expect(detect(primitives, null)).resolves.toEqual({ changed: false });

    await detect(primitives, null);
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
    const { primitives, lines } = primitivesIn("/nowhere");
    const { changes, handler } = recorder();
    const detect = detector("r", spec, handler, { fetch });

    await detect(primitives, null);
    await expect(detect(primitives, null)).resolves.toEqual({ changed: false });
    await expect(detect(primitives, null)).resolves.toEqual({ changed: false });
    expect(lines).toEqual([
      "[monitor] r poll failed: Error: HTTP 500",
      "[monitor] r poll failed: Error: offline",
    ]);
    await expect(detect(primitives, null)).resolves.toEqual({ changed: false });
    expect(changes).toHaveLength(1);
  });
});

describe("monitor factory", () => {
  const handler = () => Promise.resolve(null);

  it("routes a glob to files and a URL to http, one step and one schedule each", () => {
    monitor("guides", handler, "**/CLAUDE.md");
    monitor("releases", handler, "https://example.test/releases");
    expect(registry.monitors.get("guides")).toEqual({
      glob: "**/CLAUDE.md",
      kind: "files",
    });
    expect(registry.monitors.get("releases")).toEqual({
      kind: "http",
      url: "https://example.test/releases",
    });
    expect(registry.definitions.has("guides")).toBe(true);
    expect(registry.schedules.get("guides")).toMatchObject({
      input: null,
      kind: "monitor",
      trigger: { kind: "interval", ms: 60_000 },
      workflow: "guides",
    });
  });

  it("takes the object forms with their cadence", () => {
    monitor("a", handler, { every: "30s", glob: "*.md" });
    monitor("b", handler, { every: { hour: 9 }, url: "https://x.test" });
    expect(registry.schedules.get("a")?.trigger).toEqual({
      kind: "interval",
      ms: 30_000,
    });
    expect(registry.schedules.get("b")?.trigger).toEqual({
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
    expect(registry.schedules.get("w")).toMatchObject({
      kind: "monitor",
      trigger: { kind: "interval", ms: 60_000 },
    });
  });

  it("refuses a taken name", () => {
    step("taken", () => Promise.resolve(null));
    expect(() => {
      monitor("taken", handler, "*.md");
    }).toThrow(/already registered/);
    expect(registry.schedules.has("taken")).toBe(false);
  });
});
