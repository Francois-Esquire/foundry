import { afterEach, expect, test } from "bun:test";
import { PreviewApp } from "../preview/app";
import { dashboardSnapshot } from "../preview/snapshot";
import { DashboardView } from "../src/views/dashboard";
import { click, ctrlC, mount, press, unmount } from "./helpers/render";

let closed = false;
function close() {
  closed = true;
}

function render(width = 120, height = 40) {
  closed = false;
  return mount(<DashboardView onClose={close} snapshot={dashboardSnapshot} />, {
    height,
    width,
  });
}

afterEach(unmount);

test("quit defaults to cancel and restores the selected step", async () => {
  const ui = await render();
  await press(ui, "a");
  const before = ui.captureCharFrame();
  await press(ui, "q");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Quit Marbles?");
  expect(frame).toContain("Quitting stops schedules and monitoring");
  expect(frame).toContain("Running steps are cancelled.");
  expect(frame).toContain("Preview only:");
  expect(closed).toBe(false);
  await press(ui, "RETURN");
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toBe(before);
  await press(ui, "q");
  await press(ui, "TAB");
  await press(ui, "RETURN");
  expect(closed).toBe(true);
});

test("Ctrl+C opens confirmation and a second Ctrl+C quits", async () => {
  const ui = await render();
  await ctrlC(ui);
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toContain("Quit Marbles?");
  await ctrlC(ui);
  expect(closed).toBe(true);
});

test("Ctrl+C also confirms a dialog opened with q", async () => {
  const ui = await render();
  await press(ui, "q");
  await ctrlC(ui);
  expect(closed).toBe(true);
});

test("quit isolates search input and Escape restores its query and focus", async () => {
  const ui = await render();
  await press(ui, "/");
  await press(ui, "q");
  expect(ui.captureCharFrame()).not.toContain("Quit Marbles?");
  const before = ui.captureCharFrame();
  await ctrlC(ui);
  await press(ui, "x");
  await press(ui, "ESCAPE");
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toBe(before);
  await press(ui, "u");
  expect(ui.captureCharFrame()).toContain("Search run: qu");
});

test("modal mouse actions work and background controls cannot change selection", async () => {
  const ui = await render();
  const before = ui.captureCharFrame();
  await press(ui, "q");
  await click(ui, "trigger:daily");
  await press(ui, "ARROW_DOWN");
  await press(ui, "a");
  await click(ui, "dialog:cancel");
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toBe(before);
  await press(ui, "q");
  await click(ui, "dialog:confirm");
  expect(closed).toBe(true);
});

test("quitting from help preserves help and resets the default choice on reopen", async () => {
  const ui = await render();
  await press(ui, "?");
  const before = ui.captureCharFrame();
  await press(ui, "q");
  await press(ui, "TAB");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toBe(before);
  await ctrlC(ui);
  await press(ui, "RETURN");
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toBe(before);
});

test("quit controls remain visible in a narrow short terminal", async () => {
  const ui = await render(40, 16);
  await press(ui, "q");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Quit Marbles?");
  expect(frame).toContain("[ Keep open ]");
  expect(frame).toContain("[ Quit ]");
  expect(frame).toContain("Ctrl+C quit");
  await click(ui, "dialog:cancel");
  expect(ui.captureCharFrame()).not.toContain("Quit Marbles?");
});

test("preview scenario shortcuts are blocked while the quit dialog is open", async () => {
  const ui = await mount(<PreviewApp onClose={close} />);
  const before = ui.captureCharFrame();
  await press(ui, "q");
  await press(ui, "]");
  await press(ui, "n");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toBe(before);
});
