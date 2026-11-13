import { afterEach, expect, it, vi } from "vitest";
import { EditorSession } from "../editor/session";
import { FakeHost, workbookFile } from "./helpers/host";
import { workbooks } from "./helpers/workbooks";

const A1 = { cell: "A1", sheet: "Sheet1" };
const sessions: EditorSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.close();
  }
});

async function opened(host = new FakeHost()) {
  const session = new EditorSession(host, workbooks, "binding");
  sessions.push(session);
  await session.start();
  return session;
}

const snapshot = (session: EditorSession) => session.getSnapshot();
/** The fake watch delivers in microtasks, so one macrotask lets it finish. */
const watched = () => new Promise((resolve) => setTimeout(resolve, 0));
const contents = (session: EditorSession) =>
  snapshot(session).workbook?.contents(A1);
const enter = (session: EditorSession, text: string) =>
  session.apply({ ...A1, contents: text, kind: "enter" });

it("saves, and a new session reopens the saved formulas calculated", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "20");
  session.apply({
    cell: "B1",
    contents: "=A1*2+1",
    kind: "enter",
    sheet: "Sheet1",
  });
  await session.save();
  expect(snapshot(session)).toMatchObject({ dirty: false, message: "Saved" });
  expect(host.saves).toHaveLength(1);

  const reopened = await opened(host);
  expect(
    snapshot(reopened).workbook?.contents({ cell: "B1", sheet: "Sheet1" })
  ).toBe("=A1*2+1");
  expect(
    snapshot(reopened).workbook?.value({ cell: "B1", sheet: "Sheet1" })
  ).toEqual({ kind: "number", value: 41 });
});

it("does not reload after its own save is watched", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "2");
  await session.save();
  await vi.waitFor(() => expect(snapshot(session).newer).toBe(false));
  expect(host.reads).toBe(1);
  expect(contents(session)).toBe("2");
});

it("does not send a save when nothing changed", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  await session.save();
  enter(session, "1");
  await session.save();
  expect(host.saves).toHaveLength(0);
});

it("follows another writer's save while there are no edits", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  await vi.waitFor(() => expect(contents(session)).toBe("theirs"));
  expect(snapshot(session)).toMatchObject({ dirty: false, newer: false });
});

it("keeps edits when another writer saves, until the user loads the newer version", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "mine");
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  await vi.waitFor(() => expect(snapshot(session).newer).toBe(true));
  expect(contents(session)).toBe("mine");
  expect(snapshot(session).dirty).toBe(true);

  await session.loadNewer();
  expect(contents(session)).toBe("theirs");
  expect(snapshot(session)).toMatchObject({ dirty: false, newer: false });
});

it("keeps an edit made while a clean reload was being read", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  const release = host.hold("read");
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  await vi.waitFor(() => expect(host.reads).toBe(2));
  enter(session, "mine");
  release();
  await vi.waitFor(() => expect(snapshot(session).newer).toBe(true));
  expect(contents(session)).toBe("mine");
  expect(snapshot(session).dirty).toBe(true);
});

it("does not let a reload read before a save replace the workbook after it", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "mine");
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  await vi.waitFor(() => expect(snapshot(session).newer).toBe(true));

  const releaseRead = host.hold("read");
  const releaseSave = host.hold("save");
  const loading = session.loadNewer();
  const saving = session.save();
  // The read answers while the save is still in flight, then after it.
  releaseRead();
  await loading;
  expect(contents(session)).toBe("mine");
  releaseSave();
  await saving;
  expect(contents(session)).toBe("mine");
  expect(snapshot(session)).toMatchObject({ conflict: true, dirty: true });
});

it("keeps edits made while a save is in flight on top of the saved version", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "2");
  const release = host.hold("save");
  const saving = session.save();
  expect(snapshot(session).saving).toBe(true);
  enter(session, "3");
  // A second save waits for the first.
  await session.save();
  release();
  await saving;
  expect(snapshot(session)).toMatchObject({ dirty: true, saving: false });
  await session.save();
  expect(host.saves.map(({ expected }) => expected)).toEqual(["d1", "d2"]);
  expect(workbooks.open(host.text).contents(A1)).toBe("3");
  expect(snapshot(session).dirty).toBe(false);
});

it("loads a newer save the watch reported before its own save was answered", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "mine");
  const release = host.hold("answer");
  const saving = session.save();
  // Saved as d2; another writer saves d3 before the answer arrives.
  await vi.waitFor(() => expect(host.saves).toHaveLength(1));
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  await vi.waitFor(() => expect(snapshot(session).newer).toBe(true));
  release();
  await saving;
  await vi.waitFor(() => expect(contents(session)).toBe("theirs"));
  expect(snapshot(session)).toMatchObject({ dirty: false, newer: false });
});

it("keeps edits made during a save and still offers the newer save after it", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "mine");
  const release = host.hold("answer");
  const saving = session.save();
  await vi.waitFor(() => expect(host.saves).toHaveLength(1));
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  await vi.waitFor(() => expect(snapshot(session).newer).toBe(true));
  enter(session, "more");
  release();
  await saving;
  expect(contents(session)).toBe("more");
  expect(snapshot(session)).toMatchObject({ dirty: true, newer: true });
  expect(host.reads).toBe(1);

  await session.loadNewer();
  expect(contents(session)).toBe("theirs");
  expect(snapshot(session)).toMatchObject({ dirty: false, newer: false });
});

it("treats its own save, watched before the answer, as not newer", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "mine");
  const release = host.hold("answer");
  const saving = session.save();
  // The watch reports d2, this save, while the Draft still has base d1.
  await vi.waitFor(() => expect(snapshot(session).newer).toBe(true));
  release();
  await saving;
  expect(snapshot(session)).toMatchObject({ dirty: false, newer: false });
  expect(contents(session)).toBe("mine");
  expect(host.reads).toBe(1);
});

it("keeps a newer save reported after a lost save when keeping mine", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  const release = host.hold("save");
  enter(session, "mine");
  const saving = session.save();
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  release();
  await saving;
  expect(snapshot(session).conflict).toBe(true);
  // A third version lands, and is watched, before the user chooses.
  host.saveElsewhere(workbookFile({ A1: "third" }));
  await watched();

  session.keepLocal();
  expect(snapshot(session)).toMatchObject({ conflict: false, newer: true });
  expect(contents(session)).toBe("mine");
});

it("loads a newer save reported after a lost save when taking theirs", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  const release = host.hold("save");
  enter(session, "mine");
  const saving = session.save();
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  release();
  await saving;
  host.saveElsewhere(workbookFile({ A1: "third" }));
  await watched();

  session.takeSaved();
  await vi.waitFor(() => expect(contents(session)).toBe("third"));
  expect(snapshot(session)).toMatchObject({ dirty: false, newer: false });
});

it("offers both versions after a save loses, and keeping mine replaces theirs", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  const release = host.hold("save");
  enter(session, "mine");
  const saving = session.save();
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  release();
  await saving;
  expect(snapshot(session)).toMatchObject({ conflict: true, dirty: true });
  expect(contents(session)).toBe("mine");

  session.keepLocal();
  expect(snapshot(session).conflict).toBe(false);
  await session.save();
  expect(workbooks.open(host.text).contents(A1)).toBe("mine");
  expect(snapshot(session).dirty).toBe(false);
});

it("shows the other version when the user takes it after a lost save", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  const release = host.hold("save");
  enter(session, "mine");
  const saving = session.save();
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  release();
  await saving;

  session.takeSaved();
  expect(contents(session)).toBe("theirs");
  expect(snapshot(session)).toMatchObject({ conflict: false, dirty: false });
});

it("keeps edits and stops writing when the workbook is removed", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "mine");
  host.remove();
  await vi.waitFor(() => expect(snapshot(session).writable).toBe(false));
  expect(contents(session)).toBe("mine");
  expect(enter(session, "more")).toBe(false);
});

it("treats renaming a sheet to its own name as no edit", async () => {
  const session = await opened();
  expect(
    session.apply({ kind: "rename-sheet", sheet: "Sheet1", to: "Sheet1" })
  ).toBe(false);
  expect(snapshot(session)).toMatchObject({ dirty: false, message: "Saved" });
});

it("refuses an invalid edit without changing the workbook or dirty state", async () => {
  const session = await opened();
  expect(session.apply({ kind: "remove-sheet", sheet: "Sheet1" })).toBe(false);
  expect(snapshot(session).workbook?.sheets).toEqual(["Sheet1"]);
  expect(snapshot(session)).toMatchObject({
    dirty: false,
    message: "A workbook keeps at least one sheet",
  });
});

it("keeps read-only workbooks unchanged and does not save", async () => {
  const host = new FakeHost();
  host.writable = false;
  const session = await opened(host);
  expect(enter(session, "2")).toBe(false);
  await session.save();
  expect(contents(session)).toBe("1");
  expect(host.saves).toHaveLength(0);
});

it("reports a file that is not a workbook and opens nothing", async () => {
  const session = await opened(new FakeHost("not a workbook"));
  expect(snapshot(session)).toMatchObject({
    message: "This file is not JSON",
    ready: true,
  });
  expect(snapshot(session).workbook).toBeUndefined();
});

it("creates a workbook when none is bound and opens it", async () => {
  const host = new FakeHost();
  const session = new EditorSession(host, workbooks, null);
  sessions.push(session);
  await session.start();
  expect(snapshot(session)).toMatchObject({ binding: null, ready: true });
  await session.create();
  expect(snapshot(session)).toMatchObject({
    binding: "created-1",
    creating: false,
    dirty: false,
  });
  expect(snapshot(session).workbook?.sheets).toEqual(["Sheet1"]);
});

it("publishes nothing and aborts host requests once closed", async () => {
  const host = new FakeHost();
  const session = new EditorSession(host, workbooks, "binding");
  const listener = vi.fn();
  session.subscribe(listener);
  const release = host.hold("read");
  const starting = session.start();
  session.close();
  release();
  await starting;
  expect(listener).not.toHaveBeenCalled();
  expect(snapshot(session).workbook).toBeUndefined();
  expect(host.signals.every((signal) => signal.aborted)).toBe(true);
});

it("creates one workbook and one watch when asked twice", async () => {
  const host = new FakeHost();
  const session = new EditorSession(host, workbooks, null);
  sessions.push(session);
  await session.start();
  const release = host.hold("create");
  const first = session.create();
  const second = session.create();
  expect(snapshot(session)).toMatchObject({ creating: true });
  release();
  await Promise.all([first, second]);
  await session.create();
  expect(host).toMatchObject({ creates: 1, reads: 1, watches: 1 });
  expect(snapshot(session)).toMatchObject({
    binding: "created-1",
    creating: false,
  });
});

it("does not create while the bound workbook is opening, or after", async () => {
  const host = new FakeHost();
  const session = new EditorSession(host, workbooks, "binding");
  sessions.push(session);
  const release = host.hold("read");
  const starting = session.start();
  const creating = session.create();
  release();
  await Promise.all([starting, creating]);
  await session.create();
  expect(host).toMatchObject({ creates: 0, reads: 1, watches: 1 });
  expect(contents(session)).toBe("1");
});

it("opens the created workbook once when asked again while it is read", async () => {
  const host = new FakeHost();
  const session = new EditorSession(host, workbooks, null);
  sessions.push(session);
  await session.start();
  const release = host.hold("read");
  const first = session.create();
  await vi.waitFor(() => expect(host.reads).toBe(1));
  const second = session.create();
  release();
  await Promise.all([first, second]);
  expect(host).toMatchObject({ creates: 1, reads: 1, watches: 1 });
});

it("opens nothing when closed while creating or reading the new workbook", async () => {
  for (const held of ["create", "read"] as const) {
    const host = new FakeHost();
    const session = new EditorSession(host, workbooks, null);
    await session.start();
    const release = host.hold(held);
    const creating = session.create();
    await vi.waitFor(() =>
      expect(held === "create" ? host.creates : host.reads).toBe(1)
    );
    session.close();
    release();
    await creating;
    expect(host.watches).toBe(0);
    expect(host.reads).toBe(held === "create" ? 0 : 1);
    expect(snapshot(session).workbook).toBeUndefined();
    expect(host.signals.every((signal) => signal.aborted)).toBe(true);
  }
});

it("keeps a reported version available after its automatic reload fails", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  const read = vi.spyOn(host, "read");
  read.mockRejectedValueOnce(new Error("read unavailable"));
  host.saveElsewhere(workbookFile({ A1: "newer" }));
  await vi.waitFor(() =>
    expect(snapshot(session).message).toBe("read unavailable")
  );
  expect(snapshot(session).newer).toBe(true);
  expect(contents(session)).toBe("1");
  await session.loadNewer();
  expect(contents(session)).toBe("newer");
  expect(snapshot(session).newer).toBe(false);
});

it("retains a clean watch observation during a save after the local edit was reverted", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "sent");
  const release = host.hold("save");
  const saving = session.save();
  enter(session, "1");
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  await vi.waitFor(() => expect(host.reads).toBeGreaterThanOrEqual(1));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(snapshot(session).newer).toBe(true);
  release();
  await saving;
  expect(snapshot(session).conflict).toBe(true);
});

it("normalizes a taken conflict before comparing subsequent edits", async () => {
  const host = new FakeHost();
  const session = await opened(host);
  enter(session, "mine");
  host.saveElsewhere(
    JSON.stringify(JSON.parse(workbookFile({ A1: "theirs" })))
  );
  await session.save();
  session.takeSaved();
  enter(session, "changed");
  enter(session, "theirs");
  expect(snapshot(session).dirty).toBe(false);
});

it("reports lost live updates and clears the warning when following resumes", async () => {
  const host = new FakeHost();
  vi.spyOn(host, "watch").mockImplementation(async function* () {
    yield {
      kind: "unavailable",
      message: "Live updates disconnected",
      terminal: false,
    };
    yield {
      contentId: host.contentId,
      entry: { digest: host.digest },
      kind: "snapshot",
    };
  });
  const session = new EditorSession(host, workbooks, "binding");
  sessions.push(session);
  const messages: string[] = [];
  session.subscribe(() => messages.push(session.getSnapshot().message));
  await session.start();
  await watched();
  expect(messages).toContain("Live updates disconnected");
  expect(snapshot(session).message).toBe("Live updates restored");
  expect(contents(session)).toBe("1");
});
