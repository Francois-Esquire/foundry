import { stripANSI } from "bun";
import { afterEach, expect, test } from "vitest";
import { type TerminalScreen, terminalScreen } from "./helpers/screen";

const encoder = new TextEncoder();
const screens: TerminalScreen[] = [];

function open(cols = 40, rows = 5) {
  const screen = terminalScreen(cols, rows);
  screens.push(screen);
  return screen;
}

async function write(screen: TerminalScreen, ...chunks: string[]) {
  for (const chunk of chunks) {
    screen.write(encoder.encode(chunk));
  }
  await screen.settled();
}

afterEach(() => {
  for (const screen of screens.splice(0)) {
    screen.close();
  }
});

test("a phrase painted around unchanged cells is on screen though never contiguous in the bytes", async () => {
  const screen = open();
  await write(
    screen,
    "\x1b[?1049h\x1b[2;1HTriggers keep runing in th Marbles",
    "\x1b[2;17Hnning in the Marbles"
  );
  expect(screen.raw()).not.toContain("Triggers keep running in the Marbles");
  expect(screen.shows("Triggers keep running in the Marbles")).toBe(true);
});

test("text after a mark must be painted after it, not left over from before", async () => {
  const screen = open();
  await write(screen, "\x1b[1;1Hother workspace");
  const mark = screen.mark();
  expect(screen.shows("other")).toBe(true);
  expect(screen.shows("other", mark)).toBe(false);
  await write(screen, "\x1b[1;1Hother workspace");
  expect(screen.shows("other", mark)).toBe(false);
  await write(screen, "\x1b[3;5Hother");
  expect(screen.shows("other", mark)).toBe(true);
});

test("what a mark sees does not depend on how the bytes were chunked", async () => {
  const transitions = [
    "\x1b[1;1H\x1b[2K",
    "\x1b[1;1Hother-step",
    "\x1b[1;1H\x1b[2K",
    "\x1b[1;1Hremote-step",
  ];
  for (const chunks of [transitions, [transitions.join("")]]) {
    const screen = open();
    await write(screen, "\x1b[1;1Hremote-step");
    const mark = screen.mark();
    await write(screen, ...chunks);
    expect(screen.shows("remote-step")).toBe(true);
    expect(screen.shows("remote-step", mark)).toBe(false);
    await write(screen, "\x1b[3;1Hremote-step");
    expect(screen.shows("remote-step", mark)).toBe(true);
  }
});

test("text absent at a mark is new when it is painted where other text was", async () => {
  const screen = open();
  await write(screen, "\x1b[1;1Hremote-step");
  await write(screen, "\x1b[1;1H\x1b[2K\x1b[1;1Hother-step");
  const mark = screen.mark();
  expect(screen.shows("remote-step", mark)).toBe(false);
  await write(screen, "\x1b[1;1H\x1b[2K\x1b[1;1Hremote-step");
  expect(screen.shows("remote-step", mark)).toBe(true);
});

test("chunks written before a mark but parsed after it still count as before", async () => {
  const screen = open();
  screen.write(encoder.encode("\x1b[1;1HQuit Marbles?"));
  const mark = screen.mark();
  await screen.settled();
  expect(screen.shows("Quit Marbles?")).toBe(true);
  expect(screen.shows("Quit Marbles?", mark)).toBe(false);
});

test("a soft-wrapped line matches across its rows", async () => {
  const screen = open(20, 4);
  await write(screen, "marbles: provider configuration cannot be read");
  expect(screen.shows("configuration cannot be read")).toBe(true);
});

test("history keeps what was shown after it is painted over, though the bytes never held it whole", async () => {
  const screen = open();
  await write(
    screen,
    "\x1b[?1049h\x1b[1;1HSet up XXXXX providers",
    "\x1b[1;8Hmodel"
  );
  await write(screen, "\x1b[2J\x1b[1;1HDashboard");
  expect(stripANSI(screen.raw())).not.toContain("Set up model providers");
  expect(screen.shows("Set up model providers")).toBe(false);
  expect(screen.shown("Set up model providers")).toBe(true);
  expect(screen.shown("Choose a starter")).toBe(false);
});

test("bytes that only read as a phrase once cursor moves are stripped were emitted, not shown", async () => {
  const screen = open();
  await write(screen, "\x1b[1;1H2 \x1b[2;1HMarbles");
  expect(screen.shows("2 Marbles")).toBe(false);
  expect(screen.shown("2 Marbles")).toBe(false);
  expect(screen.emitted("2 Marbles")).toBe(true);
  expect(screen.emitted("3 Marbles")).toBe(false);
});

test("multibyte characters split across chunks decode whole", async () => {
  const screen = open();
  const bytes = encoder.encode("╭─ Runs ─╮");
  screen.write(bytes.slice(0, 1));
  screen.write(bytes.slice(1));
  await screen.settled();
  expect(screen.raw()).toBe("╭─ Runs ─╮");
  expect(screen.shows("╭─ Runs ─╮")).toBe(true);
});
