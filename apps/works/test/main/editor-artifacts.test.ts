import { moduleIdSchema } from "@foundry/modules/domain";
import type { ModuleGatewayError } from "@foundry/modules/gateway/types";
import { describe, expect, it, vi } from "vitest";
import { fileEvidence } from "~/main/artifacts/file-evidence";
import {
  ARTIFACT_CAPABILITIES,
  type ArtifactHost,
} from "~/main/artifacts/gateway/host";
import { ArtifactScopes } from "~/main/artifacts/gateway/scope";
import {
  type WatchedEntry,
  watchEntry,
  watchTarget,
} from "~/main/artifacts/gateway/watch";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import { WORKS_TASKS } from "~/shared/execution";
import {
  ALL,
  type Bound,
  EDITOR_MANIFEST,
  type Read,
  readAll,
  type Saved,
  editorHost as setup,
} from "../helpers/editor-host";
import { COMPOSED_WORKS_TIMEOUT_MS } from "../helpers/works";

function denial(promise: Promise<unknown>) {
  return expect(promise).rejects.toMatchObject({
    code: "unauthorized",
  } satisfies Partial<ModuleGatewayError>);
}

describe("Editor bindings and the Artifact providers", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, () => {
  it("creates, reads, saves and reopens a Markdown File Artifact through the returned binding", async () => {
    const { call, editorApp, execution, files, openIn, persistence } =
      await setup({ settings: { "artifacts.chunkBytes": 8 } });
    const app = await editorApp();
    const as = <T>(alias: string, input: unknown) => call<T>(app, alias, input);

    const created = await as<{
      artifactId: string;
      binding: string;
      contentId: string;
      digest: string;
      mode: string;
      path: string;
    }>("create", {
      content: "# Draft\n",
      mime: "text/markdown",
      name: "Draft",
      path: "draft.md",
      request: "create-1",
    });
    expect(created).toMatchObject({ mode: "write", path: "draft.md" });
    const read = await readAll(as, created.binding);
    expect(read).toMatchObject({ chunks: 1, text: "# Draft\n" });

    const saved = await as<Saved>("save", {
      binding: created.binding,
      expectedDigest: read.digest,
      request: "save-1",
      text: "# Draft\n\nWritten by the editor, in more than one chunk.\n",
    });
    expect(saved).toMatchObject({ evidence: "recorded", kind: "saved" });
    const again = await readAll(as, created.binding);
    expect(again.text).toBe(
      "# Draft\n\nWritten by the editor, in more than one chunk.\n"
    );
    expect(again.chunks).toBeGreaterThan(1);

    // In place: one ready Content, the one created.
    expect(
      (
        await persistence.artifacts.listContents(created.artifactId as never)
      ).map((content) => [content.id, content.state])
    ).toEqual([[created.contentId, "ready"]]);
    // Origin names the Module runtime; the engine run records the save.
    const artifact = await persistence.artifacts.get(
      created.artifactId as never
    );
    expect(artifact?.content?.metadata.origin).toMatchObject({
      actor: "module",
      installationId: moduleInstallationId(app.module.id),
      moduleId: app.module.id,
      operation: `module:${app.module.id}:save-1`,
      runtimeInstanceId: app.runtime.runtimeInstanceId,
    });
    const saves = execution.runs
      .list()
      .filter((run) => run.name === WORKS_TASKS.fileSave);
    expect(saves.map((run) => run.correlation)).toEqual([
      {
        artifactId: created.artifactId,
        moduleId: app.module.id,
        operation: `module:${app.module.id}:save-1`,
      },
    ]);
    expect(saves.flatMap(fileEvidence)).toEqual([
      expect.objectContaining({ actor: "module", moduleId: app.module.id }),
    ]);

    // Reopened from Artifacts: a fresh binding reads the saved text.
    const reopened = await openIn(created.artifactId, app.module.id, "editor");
    expect(
      (await as<Bound>("binding", { binding: reopened.binding })).entry.digest
    ).toBe(again.digest);
    expect((await readAll(as, reopened.binding)).text).toBe(again.text);
    // A file the host made is just as editable.
    const host = await files.read(created.artifactId, "draft.md", {
      length: 1024,
      offset: 0,
    });
    expect(new TextDecoder().decode(host?.data)).toBe(again.text);
  });

  it("describes the Content a binding is pinned to, and refreshes a write binding to a working version it can save", async () => {
    const { call, editorApp, files, markdownFile, openIn, persistence } =
      await setup();
    const app = await editorApp();
    const note = await markdownFile("note", "first");
    const opened = await openIn(note.artifactId, app.module.id, "editor");
    const as = <T>(alias: string, input: unknown) => call<T>(app, alias, input);
    const bound = await as<Bound>("binding", { binding: opened.binding });

    // The version the editor is on freezes; the host keeps editing a newer one.
    await persistence.artifacts.freeze(bound.contentId as never);
    const working = await files.working(note.artifactId);
    const hosted = await files.save({
      actor: { kind: "user" },
      artifactId: note.artifactId,
      expectedDigest: bound.entry.digest,
      path: "note.md",
      text: "the host's newer text",
    });
    expect(hosted).toMatchObject({ kind: "saved" });
    expect(working).not.toBe(bound.contentId);
    // Unrefreshed, the binding still describes what it reads and saves.
    expect(await as<Bound>("binding", { binding: opened.binding })).toEqual(
      expect.objectContaining({
        contentId: bound.contentId,
        entry: expect.objectContaining({ digest: bound.entry.digest }),
      })
    );

    // Frozen again with no working version: a refresh revises it once, and
    // the refreshed binding saves on its first try.
    await persistence.artifacts.freeze(working as never);
    const refreshed = await as<Bound>("binding", {
      binding: opened.binding,
      refresh: true,
    });
    expect(refreshed.contentId).not.toBe(working);
    expect(
      (await persistence.artifacts.getContent(refreshed.contentId as never))
        ?.state
    ).toBe("ready");
    expect(
      await as<Saved>("save", {
        binding: opened.binding,
        expectedDigest: refreshed.entry.digest,
        request: "after-refresh",
        text: "saved first time",
      })
    ).toMatchObject({ kind: "saved" });
  });

  it("refuses a save larger than the Module's artifacts.maxFileBytes", async () => {
    const { call, editorApp, markdownFile, openIn } = await setup({
      settings: { "artifacts.maxFileBytes": 16 },
    });
    const app = await editorApp();
    const note = await markdownFile("note", "small");
    const opened = await openIn(note.artifactId, app.module.id, "editor");
    const bound = await call<Bound>(app, "binding", {
      binding: opened.binding,
    });
    const save = (request: string, text: string) =>
      call<Saved>(app, "save", {
        binding: opened.binding,
        expectedDigest: bound.entry.digest,
        request,
        text,
      });

    await expect(save("too-big", "é".repeat(9))).rejects.toMatchObject({
      code: "invalid-input",
      message: "The file is larger than this Module may save",
    });
    await expect(save("fits", "x".repeat(16))).resolves.toMatchObject({
      kind: "saved",
    });
  });

  it("refuses Artifact calls when the Module's settings cannot be resolved, instead of using defaults", async () => {
    const { call, editorApp, markdownFile, openIn, works } = await setup({
      settings: { "artifacts.chunkBytes": 64 * 1024 },
    });
    const app = await editorApp();
    const note = await markdownFile("note", "text");
    const opened = await openIn(note.artifactId, app.module.id, "editor");
    // The saved source now asks for more than the user chose.
    const details = await works.rpc.modules.details(app.module.id);
    if (!details?.binding) {
      throw new Error("Source missing");
    }
    const { "foundry.module.json": manifestText = "{}" } = details.source;
    const manifest = JSON.parse(manifestText) as object;
    await works.rpc.modules.saveSource(
      app.module.id,
      {
        ...details.source,
        "foundry.module.json": JSON.stringify({
          ...manifest,
          settings: { "artifacts.chunkBytes": { minimum: 128 * 1024 } },
        }),
      },
      details.binding
    );

    await expect(
      call(app, "read", { binding: opened.binding })
    ).rejects.toMatchObject({
      code: "unauthorized",
      message:
        "This Module's settings have unmet requirements; review them in its settings",
    });
  });

  it("lets one runtime own several bindings", async () => {
    const { call, editorApp, markdownFile, openIn } = await setup();
    const app = await editorApp();
    const as = <T>(alias: string, input: unknown) => call<T>(app, alias, input);
    const first = await markdownFile("first", "one");
    const second = await markdownFile("second", "two");
    const a = await openIn(first.artifactId, app.module.id, "editor");
    const b = await openIn(second.artifactId, app.module.id, "editor");
    for (const [request, text] of [
      [a, "one!"],
      [b, "two!"],
    ] as const) {
      const bound = await as<Bound>("binding", { binding: request.binding });
      expect(bound.mode).toBe("write");
      await expect(
        as<Saved>("save", {
          binding: request.binding,
          expectedDigest: bound.entry.digest,
          request: `save-${text}`,
          text,
        })
      ).resolves.toMatchObject({ kind: "saved" });
    }
    expect((await readAll(as, a.binding)).text).toBe("one!");
    expect((await readAll(as, b.binding)).text).toBe("two!");
  });

  it("denies saving through a read-only binding, and any use of another runtime's", async () => {
    const { call, editorApp, markdownFile, openIn, start, watch, persistence } =
      await setup();
    const app = await editorApp();
    const other = await editorApp("Other editor");
    const file = await markdownFile("notes", "text");
    const preview = await openIn(file.artifactId, app.module.id, "preview");
    const bound = await call<Bound>(app, "binding", {
      binding: preview.binding,
    });
    expect(bound.mode).toBe("read");
    await denial(
      call(app, "save", {
        binding: preview.binding,
        expectedDigest: bound.entry.digest,
        request: "x",
        text: "changed",
      })
    );
    // Another Module's runtime cannot resolve, read, save or watch it.
    const editing = await openIn(file.artifactId, app.module.id, "editor");
    await call(app, "binding", { binding: editing.binding });
    await denial(call(other, "binding", { binding: editing.binding }));
    await denial(call(other, "read", { binding: editing.binding }));
    await denial(
      call(other, "save", {
        binding: editing.binding,
        expectedDigest: bound.entry.digest,
        request: "y",
        text: "stolen",
      })
    );
    // A stream reports its refusal on the first read.
    await denial((await watch(other, { binding: editing.binding })).next());
    // Nor can the same Module's next runtime once this one stopped.
    await app.app.close();
    const restarted = await start(app.version);
    await denial(
      call({ ...restarted, version: app.version }, "read", {
        binding: editing.binding,
      })
    );
    expect(
      new TextDecoder().decode(
        (
          await persistence.artifacts.readFile(
            file.contentId as never,
            "notes.md"
          )
        )?.blob
      )
    ).toBe("text");
  });

  it("returns a conflict on a stale save, keeping the saved text and the editor's own", async () => {
    const { call, editorApp, markdownFile, openIn } = await setup();
    const app = await editorApp();
    const file = await markdownFile("shared", "base");
    const opened = await openIn(file.artifactId, app.module.id, "editor");
    const base = await call<Bound>(app, "binding", { binding: opened.binding });
    await call(app, "save", {
      binding: opened.binding,
      expectedDigest: base.entry.digest,
      request: "agent",
      text: "the agent's edit",
    });
    const stale = await call<{
      current: { text: string };
      kind: string;
    }>(app, "save", {
      binding: opened.binding,
      expectedDigest: base.entry.digest,
      request: "human",
      text: "my edit",
    });
    expect(stale).toMatchObject({
      current: { text: "the agent's edit" },
      kind: "conflict",
    });
  });

  it("answers a retried save and create from their committed operation", async () => {
    const { call, editorApp, execution } = await setup();
    const app = await editorApp();
    const create = {
      content: "a",
      mime: "text/markdown",
      name: "Once",
      path: "once.md",
      request: "c1",
    };
    const first = await call<{ artifactId: string; binding: string }>(
      app,
      "create",
      create
    );
    const retried = await call<{
      artifactId: string;
      binding: string;
      retried: boolean;
    }>(app, "create", create);
    expect(retried).toMatchObject({
      artifactId: first.artifactId,
      retried: true,
    });
    expect(retried.binding).not.toBe(first.binding);
    await denial(call(app, "create", { ...create, content: "b" }));

    const bound = await call<Bound>(app, "binding", { binding: first.binding });
    const save = {
      binding: first.binding,
      expectedDigest: bound.entry.digest,
      request: "s1",
      text: "saved once",
    };
    await call(app, "save", save);
    expect(
      await call<Saved>(app, "save", { ...save, retry: true })
    ).toMatchObject({ kind: "saved", retried: true });
    expect(
      await call<Saved>(app, "save", { ...save, text: "different" })
    ).toMatchObject({ kind: "refused" });
    expect(
      execution.runs.list().filter((run) => run.name === WORKS_TASKS.fileSave)
    ).toHaveLength(1);
  });

  it("refuses a save whose Grant was revoked before its transaction, and keeps one that committed", async () => {
    const { call, editorApp, markdownFile, openIn, persistence, works } =
      await setup();
    const app = await editorApp();
    const file = await markdownFile("guarded", "start");
    const opened = await openIn(file.artifactId, app.module.id, "editor");
    const base = await call<Bound>(app, "binding", { binding: opened.binding });
    await expect(
      call(app, "save", {
        binding: opened.binding,
        expectedDigest: base.entry.digest,
        request: "kept",
        text: "committed before the revoke",
      })
    ).resolves.toMatchObject({ kind: "saved" });
    const current = await call<Bound>(app, "binding", {
      binding: opened.binding,
    });

    // The save is admitted; as it reaches its write, a revoke takes the
    // store's write lock first, so the save's transaction sees the revoke.
    let revoking: Promise<unknown> | undefined;
    const save = works.testing.files.save.bind(works.testing.files);
    vi.spyOn(works.testing.files, "save").mockImplementationOnce((input) => {
      revoking = persistence.modules.transaction(() =>
        persistence.modules.revokeInstallationGrant({
          capability: ARTIFACT_CAPABILITIES.save,
          expectedGeneration: app.runtime.generation,
          installationId: app.runtime.installationId,
        })
      );
      return save(input);
    });
    const saving = call<{ kind: string; reason: string }>(app, "save", {
      binding: opened.binding,
      expectedDigest: current.entry.digest,
      request: "late",
      text: "after the revoke",
    });
    await expect.poll(() => revoking).toBeDefined();
    await revoking;
    expect(await saving).toMatchObject({
      kind: "denied",
      reason: `${ARTIFACT_CAPABILITIES.save} is not approved`,
    });
    expect(
      new TextDecoder().decode(
        (
          await persistence.artifacts.readFile(
            file.contentId as never,
            "guarded.md"
          )
        )?.blob
      )
    ).toBe("committed before the revoke");
  });

  it("watches a bound entry: snapshot, changes once, reconnect with a gap, removal and revocation", async () => {
    const {
      access,
      call,
      editorApp,
      markdownFile,
      openIn,
      watch,
      persistence,
    } = await setup();
    const app = await editorApp();
    const file = await markdownFile("watched", "v1");
    const opened = await openIn(file.artifactId, app.module.id, "editor");
    const base = await call<Bound>(app, "binding", { binding: opened.binding });

    const controller = new AbortController();
    const stream = await watch(
      app,
      { binding: opened.binding },
      controller.signal
    );
    const snapshot = await stream.next();
    expect(snapshot.value).toMatchObject({
      contentId: file.contentId,
      entry: { digest: base.entry.digest, path: "watched.md" },
      gap: false,
      kind: "snapshot",
    });

    await call(app, "save", {
      binding: opened.binding,
      expectedDigest: base.entry.digest,
      request: "w1",
      text: "v2",
    });
    const change = await stream.next();
    expect(change.value).toMatchObject({ kind: "change" });
    const seen = (change.value as WatchedEntry).entry?.digest;
    expect(seen).not.toBe(base.entry.digest);

    // Recovery tells observers again; the same committed state is not a change.
    await persistence.artifacts.recover();
    const pending = stream.next();
    const later = await call<Bound>(app, "binding", {
      binding: opened.binding,
    });
    await call(app, "save", {
      binding: opened.binding,
      expectedDigest: later.entry.digest,
      request: "w2",
      text: "v3",
    });
    const v3 = (await pending).value as WatchedEntry;
    expect(v3.kind).toBe("change");
    controller.abort();
    await stream.return?.();

    // Reconnect: a fresh snapshot, reporting what moved since it last saw.
    const fresh = await watch(app, {
      after: { contentId: file.contentId, digest: seen },
      binding: opened.binding,
    });
    expect((await fresh.next()).value).toMatchObject({
      entry: { digest: v3.entry?.digest },
      gap: true,
      kind: "snapshot",
    });
    const current = await watch(app, {
      after: { contentId: file.contentId, digest: v3.entry?.digest },
      binding: opened.binding,
    });
    expect((await current.next()).value).toMatchObject({ gap: false });

    // Removal ends the stream.
    await persistence.artifacts.archive(file.artifactId as never);
    expect((await fresh.next()).value).toMatchObject({ kind: "removed" });
    expect((await fresh.next()).done).toBe(true);

    // Revoking the watch Grant ends a live watch and refuses new ones.
    await persistence.artifacts.unarchive(file.artifactId as never);
    const live = await watch(app, { binding: opened.binding });
    await live.next();
    const ended = expect(live.next()).rejects.toMatchObject({
      code: "cancelled",
    });
    await access.revoke(app.module.id, ARTIFACT_CAPABILITIES.watch);
    await ended;
    await denial(watch(app, { binding: opened.binding }));
    await current.return?.();
  });

  it("invalidates the Installation's bindings when a binding Capability is revoked", async () => {
    const { access, call, editorApp, markdownFile, openIn, watch } =
      await setup();
    const app = await editorApp();
    const file = await markdownFile("revoked", "text");
    const opened = await openIn(file.artifactId, app.module.id, "editor");
    await call(app, "binding", { binding: opened.binding });
    const live = await watch(app, { binding: opened.binding });
    await live.next();
    const ended = live.next();
    await access.revoke(app.module.id, ARTIFACT_CAPABILITIES.read);
    // The watch Grant still stands; its binding is gone, so the stream ends.
    expect((await ended).done).toBe(true);
    await access.approve(app.module.id, ARTIFACT_CAPABILITIES.read);
    await denial(call(app, "read", { binding: opened.binding }));
  });

  it("requires approved read and save Grants before creating a file", async () => {
    const { call, editorApp } = await setup();
    const app = await editorApp("No save", [
      ARTIFACT_CAPABILITIES.create,
      ARTIFACT_CAPABILITIES.read,
    ]);
    await denial(
      call(app, "create", {
        content: "x",
        mime: "text/markdown",
        name: "Nope",
        path: "nope.md",
        request: "c",
      })
    );
    const allowed = await editorApp("Too big");
    await expect(
      call(allowed, "create", {
        content: "x".repeat(5000),
        mime: "text/markdown",
        name: "Big",
        path: "big.md",
        request: "big",
      })
    ).rejects.toMatchObject({ code: "invalid-input" });
    await denial(
      call(allowed, "create", {
        content: "<p>x</p>",
        mime: "text/html",
        name: "Page",
        path: "page.html",
        request: "html",
      })
    );
  });
});

/** The editor plus a broader scope: every Markdown Artifact, listed and read by id. */
const SCOPED_MANIFEST = {
  ...EDITOR_MANIFEST,
  capabilities: [
    ...EDITOR_MANIFEST.capabilities,
    {
      alias: "list",
      capability: ARTIFACT_CAPABILITIES.list,
      constraints: { types: ["text/markdown"] },
      reason: "Lists your Markdown files",
      version: 1,
    },
  ],
};

const SCOPED = [...ALL, ARTIFACT_CAPABILITIES.list];
const NOT_IN_SCOPE = "This Artifact is not available to this app";
const MARKDOWN_PATH = /\.md$/;

interface Listed {
  items: {
    artifactId: string;
    entry: { path: string } | null;
    type: string;
  }[];
  next: string | null;
}

describe("Broader Artifact scope", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, () => {
  it("lists only the Artifacts its approved scope covers, a page at a time", async () => {
    const { call, editorApp, files, markdownFile } = await setup({
      settings: { "explorer.pageSize": 2 },
    });
    const app = await editorApp("Scoped", SCOPED, SCOPED_MANIFEST);
    const notes = [
      await markdownFile("one", "1"),
      await markdownFile("two", "2"),
      await markdownFile("three", "3"),
    ];
    const plain = await files.create({
      actor: { kind: "user" },
      bytes: new TextEncoder().encode("plain"),
      mime: "text/plain",
      name: "Plain",
      path: "plain.txt",
    });
    expect(plain.kind).toBe("created");

    const first = await call<Listed>(app, "list", {});
    expect(first.items).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await call<Listed>(app, "list", { cursor: first.next });
    expect(second.next).toBeNull();
    const listed = [...first.items, ...second.items];
    expect(listed.map((item) => item.artifactId).sort()).toEqual(
      notes.map((note) => note.artifactId).sort()
    );
    expect(listed.every((item) => item.type === "text/markdown")).toBe(true);
    expect(listed[0]?.entry?.path).toMatch(MARKDOWN_PATH);
    await expect(
      call(app, "list", { cursor: "not-a-cursor" })
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("reads and watches an Artifact in scope by id, and refuses every other id alike", async () => {
    const { call, editorApp, files, markdownFile, watch } = await setup();
    const app = await editorApp("Scoped", SCOPED, SCOPED_MANIFEST);
    const note = await markdownFile("note", "# Note");
    const read = await call<Read>(app, "read", { artifactId: note.artifactId });
    expect(Buffer.from(read.data, "base64").toString()).toBe("# Note");
    expect(
      await call<Read>(app, "read", {
        artifactId: note.artifactId,
        path: "note.md",
      })
    ).toMatchObject({ digest: read.digest });

    const plain = await files.create({
      actor: { kind: "user" },
      bytes: new TextEncoder().encode("plain"),
      mime: "text/plain",
      name: "Plain",
      path: "plain.txt",
    });
    const outside = [
      plain.kind === "created" ? plain.artifactId : "",
      app.module.artifactId,
      "art_00000000000000000000000000",
    ];
    for (const artifactId of outside) {
      await expect(call(app, "read", { artifactId })).rejects.toMatchObject({
        code: "unauthorized",
        message: NOT_IN_SCOPE,
      });
    }
    await expect(
      call(app, "read", { artifactId: note.artifactId, path: "missing.md" })
    ).rejects.toMatchObject({ message: NOT_IN_SCOPE });
    await expect(
      call(app, "read", { artifactId: note.artifactId, binding: "b" })
    ).rejects.toMatchObject({ code: "invalid-input" });

    const stream = await watch(app, { artifactId: note.artifactId });
    expect((await stream.next()).value).toMatchObject({
      artifactId: note.artifactId,
      entry: { digest: read.digest, path: "note.md" },
      kind: "snapshot",
    });
    const saved = await files.save({
      actor: { kind: "user" },
      artifactId: note.artifactId,
      expectedDigest: read.digest,
      path: "note.md",
      text: "# Note, edited",
    });
    expect(saved.kind).toBe("saved");
    expect((await stream.next()).value).toMatchObject({ kind: "change" });
    await stream.return?.();
    const refused = await watch(app, { artifactId: outside[0] });
    await expect(refused.next()).rejects.toMatchObject({
      message: NOT_IN_SCOPE,
    });
  });

  it("refuses a scoped watch whose list Grant is revoked while the watch is being set up", async () => {
    const { access, editorApp, markdownFile, persistence, works } =
      await setup();
    const app = await editorApp("Scoped", ALL, SCOPED_MANIFEST);
    await access.approve(app.module.id, ARTIFACT_CAPABILITIES.list);
    const note = await markdownFile("note", "text");
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { modules } = persistence;
    // The watch reads the Grants, then the release's Manifest: the revoke
    // lands in between.
    const host: ArtifactHost = {
      artifacts: persistence.artifacts,
      bindings: works.testing.bindings,
      files: works.testing.files,
      limits: (moduleId) => works.rpc.moduleSettings.artifactLimits(moduleId),
      modules: {
        loadGatewayContext: (id) => modules.loadGatewayContext(id),
        async loadRetainedManifest(contentId) {
          paused.resolve();
          await release.promise;
          return modules.loadRetainedManifest(contentId);
        },
      },
    };
    const scopes = new ArtifactScopes();
    const principal = {
      ...app.runtime,
      moduleId: moduleIdSchema.parse(app.module.id),
    };
    const target = watchTarget(host, scopes, principal, {
      artifactId: note.artifactId,
    });
    await paused.promise;
    await access.revoke(app.module.id, ARTIFACT_CAPABILITIES.list);
    // What the list capability's revoke hook does to the watches it ends.
    scopes.revoke(principal.installationId);
    release.resolve();
    const stream = watchEntry(
      host,
      await target,
      undefined,
      new AbortController().signal
    );

    await expect(stream.next()).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("stays binding-only until the scope is approved, and its revocation ends scoped reads and watches", async () => {
    const { access, call, editorApp, markdownFile, openIn, watch } =
      await setup();
    const app = await editorApp("Scoped", ALL, SCOPED_MANIFEST);
    const note = await markdownFile("note", "text");
    const opened = await openIn(note.artifactId, app.module.id, "editor");
    expect((await access.get(app.module.id)).scope.artifacts).toEqual([]);
    await denial(call(app, "list", {}));
    await expect(
      call(app, "read", { artifactId: note.artifactId })
    ).rejects.toMatchObject({ message: NOT_IN_SCOPE });
    await call(app, "read", { binding: opened.binding });

    await access.approve(app.module.id, ARTIFACT_CAPABILITIES.list);
    expect((await access.get(app.module.id)).scope.artifacts).toEqual([
      "text/markdown",
    ]);
    await call(app, "read", { artifactId: note.artifactId });
    const live = await watch(app, { artifactId: note.artifactId });
    await live.next();
    const ended = expect(live.next()).rejects.toMatchObject({
      code: "unauthorized",
    });

    await access.revoke(app.module.id, ARTIFACT_CAPABILITIES.list);
    await ended;
    await denial(call(app, "list", {}));
    await expect(
      call(app, "read", { artifactId: note.artifactId })
    ).rejects.toMatchObject({ message: NOT_IN_SCOPE });
    // Declining the broader scope leaves the binding as it was.
    await call(app, "read", { binding: opened.binding });
  });
});
