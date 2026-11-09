import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DOCUMENTS_PACKAGE_PATH } from "@foundry/documents";
import { createModuleGateway } from "@foundry/modules/gateway/module-gateway";
import { afterEach, expect, it } from "vitest";
import { ARTIFACT_CAPABILITIES } from "~/main/artifacts/gateway/host";
import { EXECUTION_CAPABILITIES } from "~/main/execution/capabilities";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import { createModuleProxy } from "~/main/modules/runtime/proxy";
import { connectModuleSocket } from "~/main/modules/runtime/websocket";
import { COMPOSED_WORKS_TIMEOUT_MS, composeTestWorks } from "../helpers/works";

const cleanups: (() => Promise<void>)[] = [];
const EVENT_PREFIX = /^data: /;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** The released Program from `artifact/`, run by Bun on the host instead of a VM. */
async function startProgram(release: string): Promise<string> {
  const child = spawn("bun", [path.join(release, "outputs/program.js")], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  cleanups.push(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  const lines = createInterface({ input: child.stdout });
  const [line] = (await once(lines, "line", {
    signal: AbortSignal.timeout(10_000),
  })) as [string];
  return `http://127.0.0.1:${line.replace("listening ", "")}`;
}

/** Reads server-sent events from a streamed response, one JSON value each. */
function events(response: Response) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<Record<string, unknown> | null> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const event = buffer.slice(0, boundary).replace(EVENT_PREFIX, "");
          buffer = buffer.slice(boundary + 2);
          return JSON.parse(event) as Record<string, unknown>;
        }
        const read = await reader?.read();
        if (!read || read.done) {
          return null;
        }
        buffer += decoder.decode(read.value, { stream: true });
      }
    },
    stop: () => reader?.cancel(),
  };
}

/**
 * The built fixture imported into one Works "process" with the Artifact
 * and execution providers, its access approved, and its Program running on
 * the host behind the real Gateway and Works' proxy.
 */
async function fixtureApp() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "works-fixture-"))
  );
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const { programs, works } = await composeTestWorks(root);
  cleanups.push(() => works.close());
  const { execution, files } = works.testing;
  const explorer = works.rpc.artifacts;

  // Loaded explicitly from its built package, not preinstalled: its editor
  // is offered before any Installation exists.
  const imported = await works.rpc.modules.importPackage(
    await readFile(DOCUMENTS_PACKAGE_PATH, "utf8")
  );
  const notes = await files.create({
    actor: { kind: "user" },
    bytes: new TextEncoder().encode("# Notes\n"),
    mime: "text/markdown",
    name: "Notes",
    path: "notes.md",
  });
  if (notes.kind !== "created") {
    throw new Error(notes.reason);
  }
  const resolved = await explorer.resolve({ id: notes.artifactId });
  expect(resolved).toMatchObject({
    candidates: [{ mode: "write", moduleId: imported.id, view: "editor" }],
    kind: "editors",
  });
  for (const capability of [
    ...Object.values(ARTIFACT_CAPABILITIES),
    ...Object.values(EXECUTION_CAPABILITIES),
  ]) {
    await works.rpc.access.approve(imported.id, capability);
  }
  const contentId = (await works.rpc.modules.details(imported.id))?.releases[0]
    ?.contentId;
  const version = contentId
    ? await works.rpc.modules.release(imported.id, contentId)
    : null;
  if (!version) {
    throw new Error("Imported release missing");
  }

  // The Program runs from its selected release's `artifact/`, connected to
  // the real Gateway; the View's requests pass through Works' proxy.
  const app = await works.testing.runtime.start(
    version,
    new AbortController().signal
  );
  cleanups.push(() => app.close());
  const runtime = await programs.programs.active(
    moduleInstallationId(imported.id)
  );
  const release = programs.mounted.at(-1);
  if (!(runtime && release)) {
    throw new Error("Program not started");
  }
  const origin = await startProgram(release);
  const session = await createModuleGateway({
    runtimeDispatcher: programs.invocations,
    store: works.testing.persistence.modules,
  }).connect({
    capabilities: version.manifest.capabilities,
    runtime,
    transport: await connectModuleSocket({
      url: new URL("/_foundry/module-gateway", origin.replace("http:", "ws:")),
    }),
  });
  cleanups.push(() => session.close("test complete"));
  const endpoint = {
    origin,
    signal: new AbortController().signal,
    views: [
      { id: "editor", path: "/" },
      { id: "workflows", path: "/workflows" },
    ],
  };
  const proxy = createModuleProxy({ endpoint: () => endpoint }, fetch);
  const view = (pathname: string, init?: RequestInit) =>
    proxy(new Request(new URL(pathname, "module-app://token"), init));
  /** A watch, as the fixture's Views ask for one: an event stream. */
  const follow = (pathname: string) =>
    view(pathname, { headers: { accept: "text/event-stream" } });
  const call = async <T>(
    alias: string,
    input: unknown,
    route = "/_module/artifacts"
  ) => {
    const response = await view(route, {
      body: JSON.stringify({ alias, input }),
      method: "POST",
    });
    return (await response.json()) as
      | { code: string; ok: false }
      | { ok: true; output: T };
  };
  return {
    call,
    execution,
    explorer,
    files,
    follow,
    imported,
    notes,
    view,
    works,
  };
}

it("imports the built fixture and edits a Markdown File Artifact through its View's routes", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, async () => {
  const { call, explorer, files, follow, imported, notes, view } =
    await fixtureApp();
  const opened = await explorer.open({
    contentId: notes.contentId,
    entry: "notes.md",
    id: notes.artifactId,
    moduleId: imported.id,
    view: "editor",
  });

  // The View itself is served with its binding in the URL.
  const page = await view(`/?binding=${opened.binding}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('src="/view.js"');

  const bound = await call<{ entry: { digest: string }; mode: string }>(
    "binding",
    { binding: opened.binding }
  );
  expect(bound).toMatchObject({ ok: true, output: { mode: "write" } });
  const digest = bound.ok ? bound.output.entry.digest : "";
  const read = await call<{ data: string }>("read", {
    binding: opened.binding,
  });
  expect(
    read.ok && Buffer.from(read.output.data, "base64").toString("utf8")
  ).toBe("# Notes\n");

  const watch = events(
    await follow(`/_module/artifacts/watch?binding=${opened.binding}`)
  );
  expect(await watch.next()).toMatchObject({
    entry: { digest },
    kind: "snapshot",
  });
  expect(
    await call("save", {
      binding: opened.binding,
      expectedDigest: digest,
      request: "fixture-save",
      text: "# Notes\n\nFrom the fixture.\n",
    })
  ).toMatchObject({ ok: true, output: { kind: "saved" } });
  expect(await watch.next()).toMatchObject({ kind: "change" });
  await watch.stop();

  // Reopened, the host reads what the fixture saved.
  const saved = await files.read(notes.artifactId, "notes.md", {
    length: 1024,
    offset: 0,
  });
  expect(new TextDecoder().decode(saved?.data)).toBe(
    "# Notes\n\nFrom the fixture.\n"
  );

  // The fixture can create a file of its own and edit it through the
  // binding it gets back. Anything but a relayed alias is refused.
  const created = await call<{ binding: string; digest: string }>("create", {
    content: "# New\n",
    mime: "text/markdown",
    name: "New",
    path: "new.md",
    request: "fixture-create",
  });
  expect(created).toMatchObject({ ok: true });
  if (created.ok) {
    expect(
      await call("save", {
        binding: created.output.binding,
        expectedDigest: created.output.digest,
        request: "fixture-save-2",
        text: "# New\n\nEdited.\n",
      })
    ).toMatchObject({ ok: true, output: { kind: "saved" } });
  }
  expect(await call("watch", { binding: opened.binding })).toEqual({
    code: "unknown-alias",
    ok: false,
  });
  // A made-up binding confers nothing.
  expect(await call("read", { binding: "not-a-binding" })).toEqual({
    code: "unauthorized",
    ok: false,
  });
});

it("starts, follows and cancels a registered workflow, and reads files in its scope, through the fixture's routes", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, async () => {
  const { call, execution, follow, imported, notes, view, works } =
    await fixtureApp();
  const page = await view("/workflows");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('src="/workflows.js"');

  // The approved scope lists Markdown files, which it then reads by id.
  const listed = await call<{ items: { artifactId: string }[] }>("files", {});
  expect(listed).toMatchObject({
    ok: true,
    output: { items: [{ artifactId: notes.artifactId }] },
  });
  const read = await call<{ data: string }>("read", {
    artifactId: notes.artifactId,
  });
  expect(
    read.ok && Buffer.from(read.output.data, "base64").toString("utf8")
  ).toBe("# Notes\n");

  const start = (request: string, count: number, intervalMs: number) =>
    call<{ execution: string }>(
      "start",
      {
        input: { count, intervalMs },
        request,
        version: 1,
        workflow: "works.examples.ticker",
      },
      "/_module/execution"
    );
  const quick = await start("quick", 2, 5);
  if (!quick.ok) {
    throw new Error(quick.code);
  }
  const done = events(
    await follow(`/_module/execution/watch?execution=${quick.output.execution}`)
  );
  let last: Record<string, unknown> | null = null;
  for (let next = await done.next(); next; next = await done.next()) {
    last = next;
  }
  expect(last).toMatchObject({ output: { ticks: 2 }, status: "complete" });

  const long = await start("long", 50, 1000);
  if (!long.ok) {
    throw new Error(long.code);
  }
  const followed = events(
    await follow(`/_module/execution/watch?execution=${long.output.execution}`)
  );
  expect(await followed.next()).toMatchObject({ kind: "snapshot" });
  expect(
    await call(
      "cancel",
      { execution: long.output.execution },
      "/_module/execution"
    )
  ).toEqual({ ok: true, output: { status: "cancelled" } });
  expect(await followed.next()).toMatchObject({ status: "cancelled" });
  expect(execution.runs.get(long.output.execution)).toMatchObject({
    correlation: { moduleId: imported.id },
    status: "cancelled",
  });

  // Revoking the start Grant refuses new starts through the View.
  await works.rpc.access.revoke(imported.id, EXECUTION_CAPABILITIES.start);
  expect(await start("after", 1, 5)).toEqual({
    code: "unauthorized",
    ok: false,
  });
  // A guessed id names nothing this app may follow.
  const guessed = events(
    await follow("/_module/execution/watch?execution=rn-guessed")
  );
  expect(await guessed.next()).toBeNull();
  expect(
    await call(
      "runs",
      { execution: long.output.execution },
      "/_module/execution"
    )
  ).toEqual({ code: "unknown-alias", ok: false });
});
