import type { Status, Todo } from "@/model/thread";

export interface Chip {
  readonly added: boolean;
  readonly id: string;
  readonly label: string;
  readonly number: number;
  readonly status: Status;
}

export interface StepRow {
  readonly after: number;
  readonly before: number;
  readonly steps: readonly Chip[];
}

const CHIP = 4;
const LINK = 2;
const MARKER = 2;
const SHORTEST_LABEL = 6;

function digits(count: number): number {
  return String(count).length;
}

function bare(from: number, to: number): number {
  let width = Math.max(to - from - 1, 0) * LINK;
  for (let number = from + 1; number <= to; number += 1) {
    width += CHIP + digits(number);
  }
  return width;
}

function markers(from: number, to: number, total: number): number {
  const before = from > 0 ? MARKER + digits(from) : 0;
  const after = to < total ? MARKER + digits(total - to) : 0;
  return before + after;
}

function shortened(title: string, room: number): string {
  if (room < SHORTEST_LABEL) {
    return "";
  }
  return title.length > room ? `${title.slice(0, room - 1)}…` : title;
}

function focusOf(todos: readonly Todo[]): number {
  const running = todos.findIndex((todo) => todo.status === "running");
  if (running >= 0) {
    return running;
  }
  const pending = todos.findIndex((todo) => todo.status === "pending");
  return pending >= 0 ? pending : todos.length - 1;
}

function windowOf(todos: readonly Todo[], width: number) {
  let from = 0;
  let to = todos.length;
  const focus = focusOf(todos);
  while (
    to - from > 1 &&
    bare(from, to) + markers(from, to, todos.length) > width
  ) {
    if (focus - from > to - 1 - focus) {
      from += 1;
    } else {
      to -= 1;
    }
  }
  return { from, to };
}

export function fitSteps(todos: readonly Todo[], width: number): StepRow {
  const { from, to } = windowOf(todos, width);
  const shown = todos.slice(from, to);
  const focus = focusOf(todos) - from;
  let room = width - bare(from, to) - markers(from, to, todos.length);
  const labels = shown.map(() => "");
  const order = [focus, ...shown.map((_, index) => index)].filter(
    (index, at, all) => index >= 0 && all.indexOf(index) === at
  );
  order.forEach((index, at) => {
    const share = at === 0 ? room : Math.floor(room / (order.length - at));
    const label = shortened(shown[index]?.title ?? "", share - 1);
    labels[index] = label;
    room -= label === "" ? 0 : label.length + 1;
  });
  return {
    after: todos.length - to,
    before: from,
    steps: shown.map((todo, index) => ({
      added: todo.added,
      id: todo.id,
      label: labels[index] ?? "",
      number: from + index + 1,
      status: todo.status,
    })),
  };
}
