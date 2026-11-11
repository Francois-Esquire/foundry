// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SheetsApp } from "../editor/app";
import { EditorSession } from "../editor/session";
import { FakeHost, workbookFile } from "./helpers/host";
import { workbooks } from "./helpers/workbooks";

const CELL_ADDRESS = /^[A-Z]+\d+$/;
const sessions: EditorSession[] = [];

afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) {
    session.close();
  }
});

async function editor(host = new FakeHost()) {
  const session = new EditorSession(host, workbooks, "binding");
  sessions.push(session);
  render(<SheetsApp session={session} />);
  await act(() => session.start());
  return { host, session };
}

const contentsField = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: CELL_ADDRESS,
  });
const cell = (address: string) =>
  screen.getByRole("button", { name: new RegExp(`^${address}[:,] `) });
const savedContents = (
  session: EditorSession,
  address: string,
  sheet = "Sheet1"
) => session.getSnapshot().workbook?.contents({ cell: address, sheet });

it("edits, calculates and saves through the React editor", async () => {
  const { host } = await editor();
  fireEvent.change(screen.getByLabelText("A1"), {
    target: { value: "=SUM(2,3)" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  await screen.findByRole("button", { name: "A1: 5" });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(host.saves).toHaveLength(1));
  expect(host.saves[0]?.text).toContain("=SUM(2,3)");
  await screen.findByText("Saved");
});

it("moves the selection and focus with the arrow keys", async () => {
  await editor();
  cell("A1").focus();
  fireEvent.keyDown(cell("A1"), { key: "ArrowRight" });
  expect(cell("B1").getAttribute("aria-current")).toBe("true");
  expect(document.activeElement).toBe(cell("B1"));
  fireEvent.keyDown(cell("B1"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(cell("B2"));
  expect(screen.getByLabelText("B2")).toBe(contentsField());
  // The edge of the visible grid stops the selection.
  fireEvent.keyDown(cell("B2"), { key: "ArrowUp" });
  fireEvent.keyDown(cell("B1"), { key: "ArrowUp" });
  expect(document.activeElement).toBe(cell("B1"));
});

it("starts editing a cell with the key typed on it, and Escape drops the typing", async () => {
  const { session } = await editor();
  fireEvent.keyDown(cell("A1"), { key: "7" });
  await waitFor(() => expect(contentsField().value).toBe("7"));
  expect(document.activeElement).toBe(contentsField());
  fireEvent.keyDown(contentsField(), { key: "Escape" });
  expect(document.activeElement).toBe(cell("A1"));
  expect(contentsField().value).toBe("1");
  expect(savedContents(session, "A1")).toBe("1");
  expect(session.getSnapshot().dirty).toBe(false);

  fireEvent.keyDown(cell("A1"), { key: "8" });
  await waitFor(() => expect(contentsField().value).toBe("8"));
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  expect(savedContents(session, "A1")).toBe("8");
  expect(cell("A1").textContent).toBe("8");
});

it("keeps refused text in the field beside the refusal", async () => {
  const { session } = await editor();
  const long = "x".repeat(32_768);
  fireEvent.change(contentsField(), { target: { value: long } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  expect(screen.getByRole("status").textContent).toBe(
    "A cell holds at most 32767 characters"
  );
  expect(contentsField().value).toBe(long);
  expect(document.activeElement).not.toBe(cell("A1"));
  expect(savedContents(session, "A1")).toBe("1");
  fireEvent.keyDown(contentsField(), { key: "Escape" });
  expect(contentsField().value).toBe("1");
});

it("enters typed contents when the field loses focus to another cell", async () => {
  const { session } = await editor();
  fireEvent.change(contentsField(), { target: { value: "42" } });
  fireEvent.blur(contentsField());
  fireEvent.click(cell("C3"));
  expect(savedContents(session, "A1")).toBe("42");
  expect(screen.getByLabelText("C3")).toBe(contentsField());
  expect(contentsField().value).toBe("");
});

it("adds, renames and switches sheets, following renamed references", async () => {
  const { session } = await editor();
  fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
  expect(
    screen.getByRole("button", { name: "Sheet2" }).getAttribute("aria-pressed")
  ).toBe("true");
  fireEvent.change(screen.getByLabelText("Sheet name"), {
    target: { value: "Totals" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect(
    screen.getByRole("button", { name: "Totals" }).getAttribute("aria-pressed")
  ).toBe("true");
  fireEvent.change(contentsField(), { target: { value: "=Sheet1!A1*2" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  expect(cell("A1").textContent).toBe("2");

  fireEvent.click(screen.getByRole("button", { name: "Sheet1" }));
  expect(cell("A1").textContent).toBe("1");
  fireEvent.change(screen.getByLabelText("Sheet name"), {
    target: { value: "Inputs" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect(savedContents(session, "A1", "Totals")).toBe("=Inputs!A1*2");
  fireEvent.click(screen.getByRole("button", { name: "Totals" }));
  expect(contentsField().value).toBe("=Inputs!A1*2");
  expect(cell("A1").textContent).toBe("2");
});

it("keeps what the user is typing when a newer save loads underneath", async () => {
  const { host, session } = await editor();
  act(() => contentsField().focus());
  fireEvent.change(contentsField(), { target: { value: "draft" } });
  act(() => host.saveElsewhere(workbookFile({ A1: "remote", B1: "remote" })));
  await waitFor(() => expect(cell("B1").textContent).toBe("remote"));
  // Same sheet, same cell: the text stays where it was typed, still focused.
  expect(contentsField().value).toBe("draft");
  expect(document.activeElement).toBe(contentsField());
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  expect(savedContents(session, "A1")).toBe("draft");
  expect(savedContents(session, "B1")).toBe("remote");
});

/** Another writer saves a workbook whose first sheet is `first`. */
function savedElsewhere(host: FakeHost, first: string, others: string[] = []) {
  const remote = workbooks.create();
  remote.renameSheet("Sheet1", first);
  for (const name of others) {
    remote.addSheet(name);
  }
  remote.enter({ cell: "A1", sheet: first }, "remote");
  act(() => host.saveElsewhere(remote.toFile()));
  remote.close();
}

it("keeps typed text, unentered, when its sheet is renamed elsewhere", async () => {
  const { host, session } = await editor();
  fireEvent.change(contentsField(), { target: { value: "pending text" } });
  savedElsewhere(host, "Renamed");
  const stranded = await screen.findByLabelText<HTMLInputElement>(
    "Not entered in Sheet1!A1"
  );
  expect(stranded.value).toBe("pending text");
  // The field shows the renamed sheet's cell and takes no typing meanwhile.
  expect(contentsField().value).toBe("remote");
  expect(contentsField().readOnly).toBe(true);
  fireEvent.blur(contentsField());
  expect(savedContents(session, "A1", "Renamed")).toBe("remote");
  expect(session.getSnapshot().dirty).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
  expect(screen.queryByLabelText("Not entered in Sheet1!A1")).toBeNull();
  expect(contentsField().readOnly).toBe(false);
});

it("keeps typed text, unentered, when its sheet is removed elsewhere", async () => {
  const host = new FakeHost();
  const { session } = await editor(host);
  fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(session.getSnapshot().dirty).toBe(false));
  fireEvent.change(contentsField(), { target: { value: "on sheet 2" } });
  // Sheet2 is gone from the newer save; Sheet1 remains.
  savedElsewhere(host, "Sheet1");
  const stranded = await screen.findByLabelText<HTMLInputElement>(
    "Not entered in Sheet2!A1"
  );
  expect(stranded.value).toBe("on sheet 2");
  // Choosing another cell does not drop it either.
  fireEvent.click(cell("B2"));
  expect(screen.getByLabelText("Not entered in Sheet2!A1")).toBe(stranded);
  expect(savedContents(session, "A1")).toBe("remote");
});

it("keeps stranded text however editing is started, until it is discarded", async () => {
  const { host, session } = await editor();
  fireEvent.change(contentsField(), { target: { value: "precious draft" } });
  savedElsewhere(host, "Renamed");
  const stranded = () =>
    screen.getByLabelText<HTMLInputElement>("Not entered in Sheet1!A1");
  await waitFor(() => expect(stranded().value).toBe("precious draft"));
  const attempts = {
    // The field is read only; a change that gets through anyway is refused.
    "a change": () =>
      fireEvent.change(contentsField(), { target: { value: "typed over" } }),
    "a double click": () => fireEvent.doubleClick(cell("A1")),
    "a typed key": () => fireEvent.keyDown(cell("A1"), { key: "z" }),
    Enter: () => fireEvent.keyDown(cell("A1"), { key: "Enter" }),
    Escape: () => fireEvent.keyDown(contentsField(), { key: "Escape" }),
    F2: () => fireEvent.keyDown(cell("A1"), { key: "F2" }),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    attempt();
    expect(stranded().value, name).toBe("precious draft");
    expect(contentsField().value, name).toBe("remote");
  }
  fireEvent.blur(contentsField());
  expect(savedContents(session, "A1", "Renamed")).toBe("remote");
  expect(session.getSnapshot().dirty).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
  fireEvent.keyDown(cell("A1"), { key: "z" });
  await waitFor(() => expect(contentsField().value).toBe("z"));
});

it("never enters stranded text in a different sheet that takes its sheet's name", async () => {
  const { host, session } = await editor();
  act(() => contentsField().focus());
  fireEvent.change(contentsField(), { target: { value: "old target draft" } });
  savedElsewhere(host, "Renamed");
  await screen.findByLabelText("Not entered in Sheet1!A1");
  const notice = () =>
    screen.getByLabelText<HTMLInputElement>("Not entered in Sheet1!A1");

  // Two later saves bring back a sheet named Sheet1. It is not the sheet
  // the text was typed for, so blurring the field enters nothing.
  for (const others of [["Renamed"], []]) {
    savedElsewhere(host, "Sheet1", others);
    await screen.findByRole("button", { name: "Sheet1" });
    expect(notice().value).toBe("old target draft");
    expect(contentsField().readOnly).toBe(true);
    fireEvent.blur(contentsField());
    expect(savedContents(session, "A1")).toBe("remote");
    expect(session.getSnapshot().dirty).toBe(false);
  }

  fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
  expect(screen.queryByLabelText("Not entered in Sheet1!A1")).toBeNull();
  fireEvent.blur(contentsField());
  expect(savedContents(session, "A1")).toBe("remote");
  expect(session.getSnapshot().dirty).toBe(false);
});

const sheetName = () => screen.getByLabelText<HTMLInputElement>("Sheet name");
const renameButton = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: "Rename" });

it("keeps a sheet name being typed when its sheet is renamed elsewhere", async () => {
  const { host, session } = await editor();
  fireEvent.change(sheetName(), { target: { value: "my unfinished name" } });
  // A save that keeps the sheet keeps the name being typed.
  act(() => host.saveElsewhere(workbookFile({ A1: "remote" })));
  await waitFor(() => expect(cell("A1").textContent).toBe("remote"));
  expect(sheetName().value).toBe("my unfinished name");

  savedElsewhere(host, "Renamed");
  const stranded = await screen.findByLabelText<HTMLInputElement>(
    "Name not given to Sheet1"
  );
  expect(stranded.value).toBe("my unfinished name");
  expect(sheetName().value).toBe("Renamed");
  expect(sheetName().readOnly).toBe(true);
  expect(renameButton().disabled).toBe(true);

  // A different Sheet1 arriving later is not given the name either.
  savedElsewhere(host, "Sheet1", ["Renamed"]);
  await screen.findByRole("button", { name: "Sheet1" });
  fireEvent.change(sheetName(), { target: { value: "typed over" } });
  fireEvent.submit(renameButton());
  expect(
    screen.getByLabelText<HTMLInputElement>("Name not given to Sheet1")
  ).toBe(stranded);
  expect(stranded.value).toBe("my unfinished name");
  expect(session.getSnapshot().workbook?.sheets).toEqual(["Sheet1", "Renamed"]);
  expect(session.getSnapshot().dirty).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
  expect(screen.queryByLabelText("Name not given to Sheet1")).toBeNull();
  expect(sheetName().value).toBe("Sheet1");
  expect(sheetName().readOnly).toBe(false);
});

it("keeps a sheet name being typed when its sheet is removed elsewhere", async () => {
  const { host, session } = await editor();
  fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(session.getSnapshot().dirty).toBe(false));
  fireEvent.change(sheetName(), { target: { value: "Totals" } });
  savedElsewhere(host, "Sheet1");
  const stranded = await screen.findByLabelText<HTMLInputElement>(
    "Name not given to Sheet2"
  );
  expect(stranded.value).toBe("Totals");
  fireEvent.submit(renameButton());
  expect(session.getSnapshot().workbook?.sheets).toEqual(["Sheet1"]);
});

it("drops a sheet name being typed when another sheet is chosen", async () => {
  await editor();
  fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
  fireEvent.change(sheetName(), { target: { value: "Unfinished" } });
  fireEvent.click(screen.getByRole("button", { name: "Sheet1" }));
  expect(sheetName().value).toBe("Sheet1");
  fireEvent.click(screen.getByRole("button", { name: "Sheet2" }));
  expect(sheetName().value).toBe("Sheet2");
});

it("enters the text when Enter is clicked with the mouse and returns focus to the grid", async () => {
  const { session } = await editor();
  const field = contentsField();
  act(() => field.focus());
  fireEvent.change(field, { target: { value: "2" } });
  const enter = screen.getByRole<HTMLButtonElement>("button", {
    name: "Enter",
  });
  // A browser moves focus to the button on mousedown, unless prevented.
  if (fireEvent.mouseDown(enter)) {
    act(() => enter.focus());
  }
  expect(enter.disabled).toBe(false);
  fireEvent.mouseUp(enter);
  fireEvent.click(enter);
  expect(savedContents(session, "A1")).toBe("2");
  expect(document.activeElement).toBe(cell("A1"));
});

it("offers to resolve a lost save", async () => {
  const { host, session } = await editor();
  fireEvent.change(contentsField(), { target: { value: "mine" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  const release = host.hold("save");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  host.saveElsewhere(workbookFile({ A1: "theirs" }));
  await act(async () => {
    release();
    await waitFor(() => expect(session.getSnapshot().conflict).toBe(true));
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Use the saved version" })
  );
  expect(cell("A1").textContent).toBe("theirs");
  expect(screen.queryByRole("button", { name: "Keep my version" })).toBeNull();
});

it("shows a workbook being created and creates only one", async () => {
  const host = new FakeHost();
  const session = new EditorSession(host, workbooks, null);
  sessions.push(session);
  render(<SheetsApp session={session} />);
  await act(() => session.start());
  const release = host.hold("create");
  fireEvent.click(screen.getByRole("button", { name: "New workbook" }));
  const creating = screen.getByRole<HTMLButtonElement>("button", {
    name: "Creating…",
  });
  expect(creating.disabled).toBe(true);
  fireEvent.click(creating);
  await act(async () => {
    release();
    await waitFor(() => expect(session.getSnapshot().workbook).toBeDefined());
  });
  expect(host).toMatchObject({ creates: 1, watches: 1 });
  expect(screen.queryByRole("button", { name: "New workbook" })).toBeNull();
});

const CHANGED_ELSEWHERE = /was renamed or removed elsewhere/;

function leaving(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

it("warns before leaving with unentered contents, including stranded text", async () => {
  const { host, session } = await editor();
  expect(leaving()).toBe(false);
  fireEvent.change(contentsField(), { target: { value: "pending" } });
  expect(session.getSnapshot().dirty).toBe(false);
  expect(leaving()).toBe(true);
  const next = workbooks.create();
  next.renameSheet("Sheet1", "Renamed");
  await act(async () => {
    host.saveElsewhere(next.toFile());
  });
  next.close();
  await screen.findByLabelText("Not entered in Sheet1!A1");
  expect(leaving()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard it" }));
  expect(leaving()).toBe(false);
});

it("warns before leaving with an unfinished sheet name", async () => {
  await editor();
  fireEvent.change(screen.getByLabelText("Sheet name"), {
    target: { value: "Unfinished" },
  });
  expect(leaving()).toBe(true);
  fireEvent.change(screen.getByLabelText("A1"), { target: { value: "2" } });
  expect(leaving()).toBe(true);
});

it("retains refused contents when the user locally renames their sheet", async () => {
  const { session } = await editor();
  const pending = "x".repeat(32_768);
  fireEvent.change(contentsField(), { target: { value: pending } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  fireEvent.change(screen.getByLabelText("Sheet name"), {
    target: { value: "Renamed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect(session.getSnapshot().workbook?.sheets).toEqual(["Renamed"]);
  expect(contentsField().readOnly).toBe(false);
  expect(contentsField().value).toBe(pending);
});

it("discards refused contents when the user explicitly removes their sheet", async () => {
  const { session } = await editor();
  fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
  fireEvent.change(contentsField(), { target: { value: "x".repeat(32_768) } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove sheet" }));
  expect(session.getSnapshot().workbook?.sheets).toEqual(["Sheet1"]);
  expect(screen.queryByText(CHANGED_ELSEWHERE)).toBeNull();
  expect(contentsField().readOnly).toBe(false);
});
