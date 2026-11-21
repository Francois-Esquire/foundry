import { Terminal as Emulator, type IBuffer } from "@xterm/headless";
import { type Subprocess, sleep, spawn, stripANSI } from "bun";
import type { TestHome } from "./home";

const SCREEN_MS = 8000;
const SCROLLBACK = 10_000;

interface Cell {
  readonly x: number;
  readonly y: number;
}

interface Line {
  readonly cells: readonly Cell[];
  readonly text: string;
}

export interface TerminalScreen {
  close(): void;
  emitted(value: string): boolean;
  mark(): number;
  raw(): string;
  settled(): Promise<void>;
  shown(value: string): boolean;
  shows(value: string, from?: number): boolean;
  text(): string;
  write(bytes: Uint8Array): void;
}

function readLines(
  buffer: IBuffer,
  start: number,
  end: number,
  cols: number
): Line[] {
  const lines: Line[] = [];
  let text = "";
  let cells: Cell[] = [];
  for (let y = start; y < end; y += 1) {
    const line = buffer.getLine(y);
    if (!line) {
      continue;
    }
    if (!line.isWrapped && y > start) {
      lines.push({ cells, text });
      text = "";
      cells = [];
    }
    for (let x = 0; x < cols; x += 1) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) {
        continue;
      }
      const chars = cell.getChars() || " ";
      text += chars;
      cells.push(
        ...Array.from({ length: chars.length }, () => ({ x, y: y - start }))
      );
    }
  }
  if (cells.length > 0) {
    lines.push({ cells, text });
  }
  return lines;
}

function occurrences(text: string, value: string) {
  const found: number[] = [];
  let index = text.indexOf(value);
  while (index !== -1) {
    found.push(index);
    index = text.indexOf(value, index + 1);
  }
  return found;
}

export function terminalScreen(cols: number, rows: number): TerminalScreen {
  const emulator = new Emulator({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: SCROLLBACK,
  });
  const decoder = new TextDecoder();
  const marks = new Map<number, readonly string[]>();
  const pending = new Set<number>();
  const history = new Set<string>();
  let raw = "";
  let received = 0;
  let parsed = 0;
  let drained: Promise<void> = Promise.resolve();

  const viewport = () => {
    const buffer = emulator.buffer.active;
    return readLines(buffer, buffer.viewportY, buffer.viewportY + rows, cols);
  };

  const painted = () => {
    const buffer = emulator.buffer.active;
    const cells: string[] = [];
    for (let y = 0; y < rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      for (let x = 0; x < cols; x += 1) {
        cells.push(line?.getCell(x)?.getChars() ?? "");
      }
    }
    return cells;
  };

  const capture = (chunk: number) => {
    if (pending.delete(chunk)) {
      marks.set(chunk, painted());
    }
    for (const line of viewport()) {
      history.add(line.text.trimEnd());
    }
    parsed = chunk;
  };

  const shown = (value: string) => {
    for (const line of history) {
      if (line.includes(value)) {
        return true;
      }
    }
    const { alternate, normal } = emulator.buffer;
    return [normal, alternate].some((buffer) =>
      readLines(buffer, 0, buffer.length, cols).some((line) =>
        line.text.includes(value)
      )
    );
  };

  return {
    close() {
      emulator.dispose();
    },
    emitted: (value) => stripANSI(raw).includes(value) || shown(value),
    mark() {
      if (received > 0 && !marks.has(received)) {
        if (parsed === received) {
          marks.set(received, painted());
        } else {
          pending.add(received);
        }
      }
      return received;
    },
    raw: () => raw,
    async settled() {
      while (parsed < received) {
        await drained;
      }
    },
    shown,
    shows(value, from = 0) {
      const before = marks.get(from);
      if (from > 0 && before === undefined) {
        return false;
      }
      const now = before === undefined ? [] : painted();
      return viewport().some((line) =>
        occurrences(line.text, value).some(
          (index) =>
            before === undefined ||
            line.cells
              .slice(index, index + value.length)
              .some(({ x, y }) => now[y * cols + x] !== before[y * cols + x])
        )
      );
    },
    text: () =>
      viewport()
        .map((line) => line.text.trimEnd())
        .join("\n"),
    write(bytes) {
      raw += decoder.decode(bytes, { stream: true });
      received += 1;
      const chunk = received;
      drained = new Promise((resolve) => {
        emulator.write(bytes, () => {
          capture(chunk);
          resolve();
        });
      });
    },
  };
}

export interface TerminalOptions {
  readonly cols: number;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly rows: number;
}

export interface OpenTerminal {
  readonly child: Subprocess;
  dispose(): Promise<void>;
  emitted(value: string): Promise<boolean>;
  mark(): number;
  readonly screen: TerminalScreen;
  see(value: string, from?: number, ms?: number): Promise<void>;
  send(value: string): Promise<void>;
  shown(value: string): Promise<boolean>;
  text(): Promise<string>;
}

export function openTerminal(
  home: TestHome,
  command: readonly string[],
  { cols, cwd, env = home.env, rows }: TerminalOptions
): OpenTerminal {
  const screen = terminalScreen(cols, rows);
  const child = spawn([...command], {
    cwd,
    env,
    terminal: {
      cols,
      data(_terminal, bytes) {
        screen.write(bytes);
      },
      rows,
    },
  });
  home.track(child.pid, true);
  return {
    child,
    async dispose() {
      child.kill();
      await child.exited;
      child.terminal?.close();
      screen.close();
    },
    async emitted(value) {
      await screen.settled();
      return screen.emitted(value);
    },
    mark: () => screen.mark(),
    screen,
    async see(value, from = 0, ms = SCREEN_MS) {
      const deadline = Date.now() + ms;
      await screen.settled();
      while (!screen.shows(value, from)) {
        if (Date.now() > deadline) {
          throw new Error(
            `Terminal did not show ${JSON.stringify(value)} (exit ${child.exitCode}). Screen:\n${screen.text()}`
          );
        }
        await sleep(25);
        await screen.settled();
      }
    },
    async send(value) {
      child.terminal?.write(value);
      await sleep(75);
    },
    async shown(value) {
      await screen.settled();
      return screen.shown(value);
    },
    async text() {
      await screen.settled();
      return screen.text();
    },
  };
}
