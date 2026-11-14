import { readFile } from "node:fs/promises";
import { SHEETS_PACKAGE_PATH } from "@foundry/sheets";
import { loadWorkbooks } from "@foundry/sheets/composition";
import {
  type ArtifactTransport,
  ArtifactWorkbookHost,
} from "@foundry/sheets/editor/artifact-host";
import { EditorSession } from "@foundry/sheets/editor/session";
import { WORKBOOK_MIME } from "@foundry/sheets/workbook/file";
import { afterEach, expect, it, vi } from "vitest";
import {
  type Cleanups,
  composeModuleWorks,
  events,
  runModuleApp,
} from "../helpers/module-app";
import { COMPOSED_WORKS_TIMEOUT_MS } from "../helpers/works";

const Workbook = await loadWorkbooks();

const cleanups: Cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const decoded = (data: string) => Buffer.from(data, "base64").toString("utf8");

/** A workbook file: Totals!A1 doubles Inputs!A1. */
function budget(input: string): string {
  const workbook = Workbook.create();
  workbook.renameSheet("Sheet1", "Inputs");
  workbook.addSheet("Totals");
  workbook.enter({ cell: "A1", sheet: "Inputs" }, input);
  workbook.enter({ cell: "A1", sheet: "Totals" }, "=Inputs!A1*2");
  const file = workbook.toFile();
  workbook.close();
  return file;
}

/** The built Sheets package imported into Works, with a workbook file to open. */
async function sheetsApp() {
  const composed = await composeModuleWorks(cleanups);
  const { works } = composed;
  const imported = await works.rpc.modules.importPackage(
    await readFile(SHEETS_PACKAGE_PATH, "utf8")
  );
  const file = await works.testing.files.create({
    actor: { kind: "user" },
    bytes: new TextEncoder().encode(budget("21")),
    mime: WORKBOOK_MIME,
    name: "Budget",
    path: "budget.workbook.json",
  });
  if (file.kind !== "created") {
    throw new Error(file.reason);
  }
  // Works offers Sheets as the editor for workbook files.
  expect(
    await works.rpc.artifacts.resolve({ id: file.artifactId })
  ).toMatchObject({
    candidates: [{ mode: "write", moduleId: imported.id, view: "editor" }],
    kind: "editors",
  });
  const app = await runModuleApp({
    cleanups,
    composed,
    moduleId: imported.id,
    views: [{ id: "editor", path: "/" }],
  });
  const opened = await works.rpc.artifacts.open({
    contentId: file.contentId,
    entry: "budget.workbook.json",
    id: file.artifactId,
    moduleId: imported.id,
    view: "editor",
  });
  return { ...app, binding: opened.binding, file, works };
}

it("edits a workbook through the Sheets View's routes, refuses a stale save and reopens the saved formulas", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, async () => {
  const { binding, call, file, follow, view, works } = await sheetsApp();
  const page = await view(`/?binding=${binding}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('src="/view.js"');
  expect((await view("/view.js")).headers.get("content-type")).toContain(
    "javascript"
  );

  // Opened as the View opens it: read, then calculated in a Workbook.
  const read = await call<{ data: string; digest: string }>("read", {
    binding,
  });
  if (!read.ok) {
    throw new Error(read.code);
  }
  const workbook = Workbook.open(decoded(read.output.data));
  expect(workbook.value({ cell: "A1", sheet: "Totals" })).toEqual({
    kind: "number",
    value: 42,
  });
  const watch = events(
    await follow(`/_module/artifacts/watch?binding=${binding}`)
  );
  expect(await watch.next()).toMatchObject({ kind: "snapshot" });

  workbook.enter({ cell: "A1", sheet: "Inputs" }, "50");
  workbook.addSheet("Notes");
  workbook.enter({ cell: "B1", sheet: "Notes" }, "=Totals!A1+Inputs!A1");
  const mine = workbook.toFile();
  const saved = await call<{ digest: string; kind: string }>("save", {
    binding,
    expectedDigest: read.output.digest,
    request: "sheets-save",
    text: mine,
  });
  expect(saved).toMatchObject({ ok: true, output: { kind: "saved" } });
  expect(await watch.next()).toMatchObject({ kind: "change" });
  await watch.stop();

  // A save fenced by the digest read before it loses, and writes nothing.
  const stale = await call<{
    current: { text: string };
    kind: string;
  }>("save", {
    binding,
    expectedDigest: read.output.digest,
    request: "sheets-stale-save",
    text: budget("1"),
  });
  expect(stale).toMatchObject({ ok: true, output: { kind: "conflict" } });
  expect(stale.ok && stale.output.current.text).toBe(mine);

  // Reopened from the host, the formulas are there and calculate again.
  const stored = await works.testing.files.read(
    file.artifactId,
    "budget.workbook.json",
    { length: 1_000_000, offset: 0 }
  );
  const reopened = Workbook.open(new TextDecoder().decode(stored?.data));
  expect(reopened.sheets).toEqual(["Inputs", "Totals", "Notes"]);
  expect(reopened.contents({ cell: "B1", sheet: "Notes" })).toBe(
    "=Totals!A1+Inputs!A1"
  );
  expect(reopened.value({ cell: "B1", sheet: "Notes" })).toEqual({
    kind: "number",
    value: 150,
  });
  workbook.close();
  reopened.close();
});

it("creates workbooks through the View's routes, and only workbooks", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, async () => {
  const { call } = await sheetsApp();
  const created = await call<{ binding: string; digest: string }>("create", {
    content: budget("3"),
    mime: WORKBOOK_MIME,
    name: "New budget",
    path: "new.workbook.json",
    request: "sheets-create",
  });
  if (!created.ok) {
    throw new Error(created.code);
  }
  const read = await call<{ data: string }>("read", {
    binding: created.output.binding,
  });
  expect(
    read.ok &&
      Workbook.open(decoded(read.output.data)).value({
        cell: "A1",
        sheet: "Totals",
      })
  ).toEqual({ kind: "number", value: 6 });

  expect(
    await call("create", {
      content: "# Not a workbook\n",
      mime: "text/markdown",
      name: "Notes",
      path: "notes.md",
      request: "sheets-create-markdown",
    })
  ).toEqual({ code: "unauthorized", ok: false });
  // Only the four Artifact requests are relayed.
  expect(await call("watch", { binding: created.output.binding })).toEqual({
    code: "unknown-alias",
    ok: false,
  });
});

it("runs the Sheets editor session over Works' proxy: open, save, follow another editor, resolve a lost save", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, async () => {
  const { binding, view } = await sheetsApp();
  // The View's own transport, pointed at Works' proxy instead of the page.
  const transport: ArtifactTransport = {
    async request(alias, input, signal) {
      const response = await view("/_module/artifacts", {
        body: JSON.stringify({ alias, input }),
        method: "POST",
        signal,
      });
      const answer = (await response.json()) as
        | { code: string; ok: false }
        | { ok: true; output: unknown };
      if (!answer.ok) {
        throw new Error(answer.code);
      }
      return answer.output;
    },
    watch: (query, signal) =>
      view(`/_module/artifacts/watch?${query}`, {
        headers: { accept: "text/event-stream" },
        signal,
      }),
  };
  const editor = async () => {
    const session = new EditorSession(
      new ArtifactWorkbookHost(transport),
      Workbook,
      binding
    );
    cleanups.push(async () => session.close());
    await session.start();
    return session;
  };
  const total = (session: EditorSession) =>
    session.getSnapshot().workbook?.value({ cell: "A1", sheet: "Totals" });
  const enter = (session: EditorSession, contents: string) =>
    session.apply({ cell: "A1", contents, kind: "enter", sheet: "Inputs" });
  const waitFor = { timeout: 10_000 };

  const mine = await editor();
  expect(mine.getSnapshot()).toMatchObject({
    name: "Budget",
    ready: true,
    writable: true,
  });
  expect(total(mine)).toEqual({ kind: "number", value: 42 });
  enter(mine, "50");
  await mine.save();
  expect(mine.getSnapshot()).toMatchObject({ dirty: false, message: "Saved" });

  // Another editor sees that save, then saves; the clean one follows it.
  const theirs = await editor();
  expect(total(theirs)).toEqual({ kind: "number", value: 100 });
  enter(theirs, "7");
  await theirs.save();
  await vi.waitFor(
    () => expect(total(mine)).toEqual({ kind: "number", value: 14 }),
    waitFor
  );

  // With edits, a newer save is only surfaced, and saving over it loses.
  enter(mine, "100");
  enter(theirs, "8");
  await theirs.save();
  await vi.waitFor(() => expect(mine.getSnapshot().newer).toBe(true), waitFor);
  expect(total(mine)).toEqual({ kind: "number", value: 200 });
  await mine.save();
  expect(mine.getSnapshot().conflict).toBe(true);
  mine.takeSaved();
  expect(total(mine)).toEqual({ kind: "number", value: 16 });
  expect(mine.getSnapshot()).toMatchObject({ conflict: false, dirty: false });
  // Both watches are still streaming when cleanup closes the Gateway.
});

it("carries the largest workbook Sheets accepts through the Gateway both ways", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, async () => {
  const { binding, call } = await sheetsApp();
  // Escaping doubles a backslash or quote and grows control characters;
  // the rest are multibyte. Fill the workbook until Sheets refuses more.
  const mixed = '\\"\n\t\u0001é漢😀'.repeat(4000).slice(0, 32_767);
  const workbook = Workbook.create();
  for (let row = 1; ; row += 1) {
    try {
      workbook.enter({ cell: `A${String(row)}`, sheet: "Sheet1" }, mixed);
    } catch (error) {
      expect(error).toMatchObject({ code: "too-large" });
      break;
    }
  }
  const largest = workbook.toFile();
  workbook.close();
  expect(
    new TextEncoder().encode(JSON.stringify(largest)).byteLength
  ).toBeGreaterThan(900_000);

  const bound = await call<{ entry: { digest: string } }>("binding", {
    binding,
  });
  if (!bound.ok) {
    throw new Error(bound.code);
  }
  const saved = await call<{ kind: string }>("save", {
    binding,
    expectedDigest: bound.output.entry.digest,
    request: "sheets-largest",
    text: largest,
  });
  expect(saved).toMatchObject({ ok: true, output: { kind: "saved" } });
  // A lost save is answered with that whole file.
  const lost = await call<{ current: { text: string }; kind: string }>("save", {
    binding,
    expectedDigest: bound.output.entry.digest,
    request: "sheets-largest-stale",
    text: budget("1"),
  });
  expect(lost).toMatchObject({ ok: true, output: { kind: "conflict" } });
  expect(lost.ok && lost.output.current.text).toBe(largest);
});

it("fails a lost save cleanly when the version saved elsewhere is too large to send back", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, async () => {
  const { binding, call, file, works } = await sheetsApp();
  const bound = await call<{ entry: { digest: string } }>("binding", {
    binding,
  });
  if (!bound.ok) {
    throw new Error(bound.code);
  }
  // Another writer saves a 1.5 MB entry: within Works' file limit, but
  // larger than one Gateway frame can carry back.
  const outsized = await works.testing.files.save({
    actor: { kind: "user" },
    artifactId: file.artifactId,
    expectedDigest: bound.output.entry.digest,
    path: "budget.workbook.json",
    text: "x".repeat(1_500_000),
  });
  expect(outsized).toMatchObject({ kind: "saved" });

  const lost = await call("save", {
    binding,
    expectedDigest: bound.output.entry.digest,
    request: "sheets-lost-to-outsized",
    text: budget("1"),
  });
  expect(lost).toEqual({ code: "capacity-exceeded", ok: false });
  const stored = await works.testing.files.read(
    file.artifactId,
    "budget.workbook.json",
    { length: 16, offset: 0 }
  );
  expect(new TextDecoder().decode(stored?.data)).toBe("x".repeat(16));
});
