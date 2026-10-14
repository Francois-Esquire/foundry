interface User {
  active: boolean;
  name: string;
}

type Toggle = boolean;

export function flat(a: string) {
  return a.trim();
}

export function nested(a: boolean, b: boolean) {
  if (a) {
    if (b) {
      return 1;
    }
  }
  return 0;
}

export function guarded(a?: User) {
  if (!a) return;
  if (!a.active) return;
  if (a.name === "") return;
  handle(a);
}

function handle(a: User) {
  void a;
}

export function ladder(v: number) {
  if (v > 10) return "big";
  else if (v > 5) return "mid";
  else if (v > 0) return "small";
  return "none";
}

export function deep(items: number[][]) {
  if (items.length > 0) {
    for (const row of items) {
      if (row.length > 0) {
        try {
          for (const cell of row) {
            if (cell > 0) {
              return cell;
            }
          }
        } catch {
          return -1;
        }
      }
    }
  }
  return 0;
}

export function pick(mode: string) {
  switch (mode) {
    case "a":
      return 1;
    case "b":
      return 2;
    case "c":
      return 3;
    default:
      return 0;
  }
}

export function ternaryLogic(a: number, b: number | undefined) {
  const bound = b ?? 0;
  const min = a < bound ? a : bound;
  const ok = min > 0 && min < 100;
  const flag = ok || a === bound;
  return flag ? min : 0;
}

export async function fetchTwice(load: () => Promise<number>) {
  const first = await load();
  const second = await load();
  return first + second;
}

export function* counter(limit: number) {
  for (let i = 0; i < limit; i += 1) {
    yield i;
  }
}

export function mapFilter(items: number[][]) {
  return items.map((row) => {
    return row.filter((cell) => {
      return cell > 0;
    });
  });
}

export class Machine {
  private count = 0;

  constructor(private readonly limit: number) {}

  get remaining(): number {
    return this.limit - this.count;
  }

  set progress(value: number) {
    this.count = value;
  }

  step(times: number): void {
    for (let i = 0; i < times; i += 1) {
      if (this.count < this.limit) {
        this.count += 1;
      }
    }
  }

  drain(handler: (value: number) => void): void {
    while (this.count > 0) {
      [0].forEach(() => {
        handler(this.count);
      });
      this.count -= 1;
    }
  }
}

export const handlers = [
  (value: number) => value + 1,
  (value: number) => value * 2,
];

export function flags(
  flag: boolean,
  literal: true | false,
  mode: "yes" | "no",
  isEnabled: number,
  maybe?: boolean,
) {
  if (flag && maybe === true) return 1;
  if (literal) return 2;
  return mode === "yes" ? 3 : isEnabled;
}

export function aliased(toggle: Toggle) {
  return toggle ? 1 : 0;
}

export function varied(first: number, second = 2, ...rest: string[]) {
  return first + second + rest.length;
}

export function exits(values: number[]) {
  for (const value of values) {
    if (value < 0) continue;
    if (value === 0) break;
    if (value > 100) throw new Error("too big");
  }
  return values.length;
}
