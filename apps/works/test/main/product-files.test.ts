import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import type { ExecutionRun } from "@foundry.sh/marbles/engine";
import { afterEach, expect, it, vi } from "vitest";
import { EditorBindings } from "~/main/artifacts/bindings";
import {
  createArtifactExplorer,
  markdownFileName,
} from "~/main/artifacts/explorer";
import { fileEvidence, originOf } from "~/main/artifacts/file-evidence";
import {
  type FileActor,
  FileWriteDenied,
  ProductFiles,
} from "~/main/artifacts/files";
import { HOST_AUDIT_SCOPE } from "~/main/execution/retention";
import { modulePersistence } from "~/main/modules/artifact-store";
import { WORKS_TASKS } from "~/shared/execution";
import { startTestExecution } from "../helpers/execution";
import { FlakyStateStore } from "../helpers/flaky-state";

const USER: FileActor = { kind: "user" };
const ONE_MIB = 1024 * 1024;
const USER_OPERATION = /^user:/;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function temporary() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "works-files-"))
  );
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

/** One Works process: the shared JSON record store, the engine, product files. */
async function open(directory: string, state?: FlakyStateStore) {
  const execution = await startTestExecution(state ? { store: state } : {});
  const store = new JsonArtifactStore({
    path: path.join(directory, "modules", ".library", "artifacts.json"),
  });
  const { artifacts } = modulePersistence(store);
  const files = new ProductFiles({
    artifacts,
    execution,
    root: path.join(directory, "artifacts"),
  });
  cleanups.push(() => files.close());
  await files.ready();
  return { artifacts, execution, files };
}

async function createNotes(files: ProductFiles, text = "# Notes\n") {
  const created = await files.create({
    actor: USER,
    bytes: new TextEncoder().encode(text),
    mime: "text/markdown",
    name: "Notes",
    path: "notes.md",
  });
  if (created.kind !== "created") {
    throw new Error(created.reason);
  }
  return created;
}

async function readText(files: ProductFiles, artifactId: string) {
  const chunk = await files.read(artifactId, "notes.md", {
    length: ONE_MIB,
    offset: 0,
  });
  if (!chunk) {
    throw new Error("missing file");
  }
  return { digest: chunk.digest, text: new TextDecoder().decode(chunk.data) };
}

function runsNamed(runs: readonly ExecutionRun[], name: string) {
  return runs.filter((run) => run.name === name);
}

it("creates a Markdown File Artifact on the host, saves it in place and reopens it", async () => {
  const directory = await temporary();
  const { artifacts, execution, files } = await open(directory);
  const created = await createNotes(files);
  const first = await readText(files, created.artifactId);
  expect(first.text).toBe("# Notes\n");

  // It is a product file with its own directory, not a Module.
  const artifact = await artifacts.get(created.artifactId as never);
  expect(artifact).toMatchObject({ type: "text/markdown" });
  expect(artifact?.content?.metadata).toMatchObject({
    entry: "notes.md",
    origin: { actor: "user", operation: expect.stringMatching(USER_OPERATION) },
  });
  const folder = await files.directory(created.artifactId);
  expect(folder.startsWith(path.join(directory, "artifacts"))).toBe(true);
  expect(await readFile(path.join(folder, "notes.md"), "utf8")).toBe(
    "# Notes\n"
  );

  const saved = await files.save({
    actor: USER,
    artifactId: created.artifactId,
    expectedDigest: first.digest,
    path: "notes.md",
    request: "save-1",
    text: "# Notes\n\nSaved.\n",
  });
  expect(saved).toMatchObject({
    contentId: created.contentId,
    evidence: "recorded",
    kind: "saved",
    retried: false,
  });
  // In place: the same Content, still ready, and no snapshot was taken.
  const contents = await artifacts.listContents(created.artifactId as never);
  expect(contents.map((content) => [content.id, content.state])).toEqual([
    [created.contentId, "ready"],
  ]);
  expect(await readFile(path.join(folder, "notes.md"), "utf8")).toBe(
    "# Notes\n\nSaved.\n"
  );

  // The origin on the Content names the engine run that recorded the save.
  const current = await artifacts.get(created.artifactId as never);
  const origin = originOf(current?.content ?? { metadata: {} });
  const [run] = runsNamed(execution.runs.list(), WORKS_TASKS.fileSave);
  expect(origin).toMatchObject({
    actor: "user",
    operation: "user:save-1",
    runId: run?.id,
  });
  expect(run).toMatchObject({
    correlation: { artifactId: created.artifactId, operation: "user:save-1" },
    queue: "system",
    status: "complete",
  });
  expect(fileEvidence(run as ExecutionRun)).toEqual([
    expect.objectContaining({
      actor: "user",
      artifactId: created.artifactId,
      contentId: created.contentId,
      path: "notes.md",
    }),
  ]);
  expect(runsNamed(execution.runs.list(), WORKS_TASKS.fileCreate)).toHaveLength(
    1
  );

  // Reopened by another process over the same records.
  await files.close();
  const reopened = await open(directory);
  expect((await readText(reopened.files, created.artifactId)).text).toBe(
    "# Notes\n\nSaved.\n"
  );
});

it("writes nothing on a stale save and returns the saved entry, so both edits survive", async () => {
  const { files } = await open(await temporary());
  const created = await createNotes(files);
  const base = await readText(files, created.artifactId);
  const mine = await files.save({
    actor: USER,
    artifactId: created.artifactId,
    expectedDigest: base.digest,
    path: "notes.md",
    text: "mine",
  });
  expect(mine.kind).toBe("saved");
  const theirs = await files.save({
    actor: USER,
    artifactId: created.artifactId,
    expectedDigest: base.digest,
    path: "notes.md",
    text: "theirs",
  });
  expect(theirs).toEqual({
    current: { bytes: 4, digest: expect.any(String), text: "mine" },
    kind: "conflict",
  });
  expect((await readText(files, created.artifactId)).text).toBe("mine");
});

it("answers a retried request from its committed operation and refuses a reused id", async () => {
  const { execution, files } = await open(await temporary());
  const created = await createNotes(files);
  const base = await readText(files, created.artifactId);
  const request = {
    actor: USER,
    artifactId: created.artifactId,
    expectedDigest: base.digest,
    path: "notes.md",
    request: "edit-1",
    text: "first",
  };
  const saved = await files.save(request);
  expect(saved).toMatchObject({ kind: "saved", retried: false });
  // The same request again: the first answer, without another write.
  expect(await files.save({ ...request, retry: true })).toMatchObject({
    digest: saved.kind === "saved" ? saved.digest : "",
    kind: "saved",
    retried: true,
  });
  expect(runsNamed(execution.runs.list(), WORKS_TASKS.fileSave)).toHaveLength(
    1
  );
  // The same id for other text fails.
  expect(await files.save({ ...request, text: "other" })).toMatchObject({
    kind: "refused",
  });

  // After a later save replaced the origin, the run store still answers.
  const later = await readText(files, created.artifactId);
  await files.save({
    ...request,
    expectedDigest: later.digest,
    request: "edit-2",
    text: "second",
  });
  expect(await files.save({ ...request, retry: true })).toMatchObject({
    kind: "saved",
    retried: true,
  });
  // Until retention has pruned anything, the run store holds every
  // committed write's result: a retry nothing vouches for never committed,
  // so it is a new request (here against an old fence: a conflict).
  expect(
    await files.save({ ...request, request: "lost", retry: true })
  ).toMatchObject({ kind: "conflict" });
  // Once retention has pruned the user's runs, it may have been one of them.
  const [oldest] = execution.runs
    .list()
    .filter((run) => run.name === WORKS_TASKS.fileSave);
  execution.runs.prune([oldest?.id ?? ""], () => HOST_AUDIT_SCOPE);
  expect(
    await files.save({ ...request, request: "lost-2", retry: true })
  ).toMatchObject({ kind: "uncertain" });
  // A Module's pruned runs say nothing about the user's requests.
  expect(execution.runs.gaps().map((gap) => gap.scope)).toEqual([
    HOST_AUDIT_SCOPE,
  ]);
  expect((await readText(files, created.artifactId)).text).toBe("second");
});

it("reports a save whose result could not be recorded, and blocks the next until it is recovered", async () => {
  const directory = await temporary();
  const state = new FlakyStateStore();
  const { execution, files } = await open(directory, state);
  const created = await createNotes(files);
  const base = await readText(files, created.artifactId);

  state.failing = true;
  const saved = await files.save({
    actor: USER,
    artifactId: created.artifactId,
    expectedDigest: base.digest,
    path: "notes.md",
    text: "saved without evidence",
  });
  expect(saved).toMatchObject({
    evidence: "recovery-required",
    kind: "saved",
  });
  const next = await readText(files, created.artifactId);
  expect(next.text).toBe("saved without evidence");
  // The next save waits while the evidence still cannot be written.
  expect(
    await files.save({
      actor: USER,
      artifactId: created.artifactId,
      expectedDigest: next.digest,
      path: "notes.md",
      text: "not yet",
    })
  ).toMatchObject({ kind: "refused" });
  expect((await readText(files, created.artifactId)).text).toBe(
    "saved without evidence"
  );

  // Once it can be, the missing result is recorded first, then the save.
  state.failing = false;
  expect(
    await files.save({
      actor: USER,
      artifactId: created.artifactId,
      expectedDigest: next.digest,
      path: "notes.md",
      text: "after recovery",
    })
  ).toMatchObject({ evidence: "recorded", kind: "saved" });
  const [recovery] = runsNamed(execution.runs.list(), WORKS_TASKS.fileRecover);
  expect(fileEvidence(recovery as ExecutionRun)).toEqual([
    expect.objectContaining({
      artifactId: created.artifactId,
      recoveredFrom: expect.any(String),
    }),
  ]);
});

it("recovers a missing save result from the origin at startup, before another save", async () => {
  const directory = await temporary();
  const state = new FlakyStateStore();
  const before = await open(directory, state);
  const created = await createNotes(before.files);
  const base = await readText(before.files, created.artifactId);
  state.failing = true;
  await before.files.save({
    actor: USER,
    artifactId: created.artifactId,
    expectedDigest: base.digest,
    path: "notes.md",
    request: "unrecorded",
    text: "committed",
  });
  await before.files.close();
  await before.execution.close();

  // The next process: the run store never got that result.
  state.failing = false;
  const after = await open(directory, state);
  const recovered = runsNamed(
    after.execution.runs.list(),
    WORKS_TASKS.fileRecover
  );
  // The recovered evidence describes the saved entry, as the save's own would.
  const saved = await readText(after.files, created.artifactId);
  expect(recovered.flatMap(fileEvidence)).toEqual([
    expect.objectContaining({
      digest: saved.digest,
      operation: "user:unrecorded",
      path: "notes.md",
      recoveredFrom: expect.any(String),
    }),
  ]);
  // Recovery is not another save: the Content is untouched.
  expect((await readText(after.files, created.artifactId)).text).toBe(
    "committed"
  );
});

it("writes disk edits back as system runs with a disk origin", async () => {
  const { artifacts, execution, files } = await open(await temporary());
  const created = await createNotes(files);
  const folder = await files.directory(created.artifactId);
  await writeFile(path.join(folder, "notes.md"), "typed in another editor");
  await vi.waitFor(
    async () =>
      expect((await readText(files, created.artifactId)).text).toBe(
        "typed in another editor"
      ),
    { timeout: 5000 }
  );
  // The run records its result just after the commit lands.
  await vi.waitFor(() => {
    const [sync] = runsNamed(execution.runs.list(), WORKS_TASKS.fileSync);
    expect(sync?.status).toBe("complete");
  });
  const current = await artifacts.get(created.artifactId as never);
  const [sync] = runsNamed(execution.runs.list(), WORKS_TASKS.fileSync);
  expect(originOf(current?.content ?? { metadata: {} })).toMatchObject({
    actor: "disk",
    runId: sync?.id,
  });
  expect(sync?.correlation).toEqual({ artifactId: created.artifactId });
  expect(fileEvidence(sync as ExecutionRun)).toEqual([
    expect.objectContaining({ actor: "disk", contentId: created.contentId }),
  ]);
});

it("keeps conflicting disk edits aside when a save lands first", async () => {
  const directory = await temporary();
  const execution = await startTestExecution();
  const store = new JsonArtifactStore({
    path: path.join(directory, "artifacts.json"),
  });
  const conflicts: string[] = [];
  const files = new ProductFiles({
    artifacts: modulePersistence(store).artifacts,
    execution,
    onConflict: (conflict) => conflicts.push(conflict.directory),
    root: path.join(directory, "artifacts"),
  });
  cleanups.push(() => files.close());
  const created = await createNotes(files);
  const base = await readText(files, created.artifactId);
  const folder = await files.directory(created.artifactId);
  await writeFile(path.join(folder, "notes.md"), "edited on disk");
  // A save that lands before the poll writes the disk edit back.
  await files.save({
    actor: USER,
    artifactId: created.artifactId,
    expectedDigest: base.digest,
    path: "notes.md",
    text: "saved in the app",
  });
  await vi.waitFor(() => expect(conflicts).toHaveLength(1), {
    timeout: 5000,
  });
  expect(await readFile(path.join(folder, "notes.md"), "utf8")).toBe(
    "saved in the app"
  );
  expect(
    await readFile(path.join(conflicts[0] ?? "", "notes.md"), "utf8")
  ).toBe("edited on disk");
});

it("opens a frozen version for writing once: a ready working successor, the frozen one kept", async () => {
  const directory = await temporary();
  const { artifacts, execution, files } = await open(directory);
  const created = await createNotes(files);
  await artifacts.freeze(created.contentId as never);
  const states = async () =>
    (await artifacts.listContents(created.artifactId as never))
      .map((content) => [content.id, content.state])
      .sort();

  const working = await files.working(created.artifactId);
  expect(working).not.toBe(created.contentId);
  // Opening again binds the same successor; nothing new is made.
  expect(await files.working(created.artifactId)).toBe(working);
  expect(await states()).toEqual(
    [
      [created.contentId, "frozen"],
      [working, "ready"],
    ].sort()
  );
  const successor = await artifacts.get(created.artifactId as never);
  expect(successor?.content?.metadata).toMatchObject({
    entry: "notes.md",
    from: created.contentId,
  });

  // Saves edit the successor in place.
  const base = await readText(files, created.artifactId);
  for (const text of ["first edit", "second edit"]) {
    const current = await readText(files, created.artifactId);
    expect(
      await files.save({
        actor: USER,
        artifactId: created.artifactId,
        expectedDigest: current.digest,
        path: "notes.md",
        text,
      })
    ).toMatchObject({ contentId: working, kind: "saved" });
  }
  expect(base.text).toBe("# Notes\n");
  expect(await states()).toHaveLength(2);
  const frozen = await artifacts.readFile(
    created.contentId as never,
    "notes.md"
  );
  expect(new TextDecoder().decode(frozen?.blob)).toBe("# Notes\n");

  // A working copy is recorded, but it is not a save.
  const [revise, ...others] = runsNamed(
    execution.runs.list(),
    WORKS_TASKS.fileRevise
  );
  expect(others).toEqual([]);
  expect(fileEvidence(revise as ExecutionRun)).toEqual([]);
  expect(revise?.observations).toEqual([
    expect.objectContaining({
      data: {
        artifactId: created.artifactId,
        contentId: working,
        from: created.contentId,
      },
      type: "revise",
    }),
  ]);
});

it("saves a frozen version a person edits directly into its working successor", async () => {
  const directory = await temporary();
  const { artifacts, files } = await open(directory);
  const created = await createNotes(files);
  await artifacts.freeze(created.contentId as never);
  const base = await readText(files, created.artifactId);

  const saved = await files.save({
    actor: USER,
    artifactId: created.artifactId,
    expectedDigest: base.digest,
    path: "notes.md",
    text: "edited after release",
  });
  expect(saved).toMatchObject({ kind: "saved" });
  expect(saved.kind === "saved" && saved.contentId).not.toBe(created.contentId);
  expect(
    (await artifacts.listContents(created.artifactId as never)).map(
      (content) => content.state
    )
  ).toEqual(expect.arrayContaining(["frozen", "ready"]));
});

it("revises nothing for a save its authority refuses", async () => {
  const directory = await temporary();
  const { artifacts, execution, files } = await open(directory);
  const created = await createNotes(files);
  await artifacts.freeze(created.contentId as never);
  const base = await readText(files, created.artifactId);

  const saved = await files.save({
    actor: {
      installationId: "installation-1",
      kind: "module",
      moduleId: "module-1",
      runtimeInstanceId: "runtime-1",
    },
    artifactId: created.artifactId,
    authorize: () => Promise.reject(new FileWriteDenied("Not approved")),
    expectedDigest: base.digest,
    path: "notes.md",
    text: "edited by a revoked Module",
  });

  expect(saved).toEqual({ kind: "denied", reason: "Not approved" });
  expect(
    (await artifacts.listContents(created.artifactId as never)).map(
      (content) => [content.id, content.state]
    )
  ).toEqual([[created.contentId, "frozen"]]);
  const revise = execution.runs
    .list()
    .find((run) => run.name === WORKS_TASKS.fileRevise);
  expect(revise?.observations).toMatchObject([
    { data: { outcome: "denied" }, type: "attempt" },
  ]);
});

it("creates a Markdown file a person names from the Artifacts destination", async () => {
  const directory = await temporary();
  const { artifacts, execution, files } = await open(directory);
  const explorer = createArtifactExplorer(artifacts, {
    bindings: new EditorBindings(),
    files,
  });

  const { id } = await explorer.create({ name: "Meeting notes" });
  const artifact = await artifacts.get(id as never);
  expect(artifact).toMatchObject({
    name: "Meeting notes",
    type: "text/markdown",
  });
  expect(artifact?.content?.metadata).toMatchObject({
    entry: "meeting-notes.md",
    origin: { actor: "user" },
  });
  const file = await artifacts.readFile(
    artifact?.contentId as never,
    "meeting-notes.md"
  );
  expect(new TextDecoder().decode(file?.blob)).toBe("# Meeting notes\n");
  expect(runsNamed(execution.runs.list(), WORKS_TASKS.fileCreate)).toHaveLength(
    1
  );
  // Not a Module: it lists as a file and resolves to its editors (none here).
  expect((await explorer.list()).map((summary) => summary.id)).toEqual([id]);
  expect(await explorer.resolve({ id })).toMatchObject({
    candidates: [],
    entry: { mime: "text/markdown", path: "meeting-notes.md" },
    kind: "editors",
  });
});

it("names a created Markdown file portably", () => {
  expect(markdownFileName("Meeting notes")).toBe("meeting-notes.md");
  expect(markdownFileName("../../etc/passwd")).toBe("etc-passwd.md");
  expect(markdownFileName("...")).toBe("untitled.md");
  expect(markdownFileName("Café plan")).toBe("cafe-plan.md");
  expect(markdownFileName("x".repeat(200))).toBe(`${"x".repeat(80)}.md`);
});
