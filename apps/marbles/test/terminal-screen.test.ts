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

test("text that leaves and comes back after a mark counts as shown again", async () => {
  const screen = open();
  await write(screen, "\x1b[1;1Hremote-step");
  const mark = screen.mark();
  await write(screen, "\x1b[1;1H\x1b[2K");
  expect(screen.shows("remote-step", mark)).toBe(false);
  await write(screen, "\x1b[1;1Hremote-step");
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

test("history keeps what was shown after it is painted over", async () => {
  const screen = open();
  await write(
    screen,
    "\x1b[?1049h\x1b[1;1HSet up",
    "\x1b[1;7H model providers"
  );
  await write(screen, "\x1b[2J\x1b[1;1HDashboard");
  expect(screen.shows("Set up model providers")).toBe(false);
  expect(screen.shown("Set up model providers")).toBe(true);
  expect(screen.shown("Choose a starter")).toBe(false);
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
