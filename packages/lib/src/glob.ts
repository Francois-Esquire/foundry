/** Compile one glob to a regex over a POSIX path. `**` crosses separators
 * (`**` before a slash matches zero or more directories), `*`/`?` do not,
 * and `{ts,tsx}` selects one of several alternatives.
 *
 * The result is a real `RegExp` with the equivalent `source`, but matching
 * (`test`, `exec`, and the string methods built on them) runs the glob as a
 * state machine instead of through the backtracking regex engine: the work
 * is bounded by pattern length times path length, however the wildcards
 * overlap. A backtracking match of `**a**a**b` against a long path does not
 * finish in any useful time. */
export function globToRegExp(pattern: string): RegExp {
  return new GlobRegExp(`^${globFragment(pattern)}$`, compileGlob(pattern));
}

class GlobRegExp extends RegExp {
  // Derived regexes (`split`, `matchAll`) are plain ones over the same source.
  static override get [Symbol.species](): RegExpConstructor {
    return RegExp;
  }

  readonly #machine: GlobMachine;

  constructor(source: string, machine: GlobMachine) {
    super(source);
    this.#machine = machine;
  }

  override exec(input: string): RegExpExecArray | null {
    const text = String(input);
    if (!runGlob(this.#machine, text)) {
      return null;
    }
    // Anchored at both ends with no capture groups: a match is the whole text.
    return Object.assign([text], {
      groups: undefined,
      index: 0,
      input: text,
    }) as RegExpExecArray;
  }

  // Recompiling would change `source` but not the machine `exec` runs.
  override compile(): never {
    throw new TypeError("A glob RegExp cannot be recompiled");
  }
}

function globFragment(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (pattern.startsWith("**/", i)) {
      out += "(?:[^/]+/)*";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (ch === "*") {
      out += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if (ch === "{") {
      const end = matchingBrace(pattern, i);
      if (end === -1) {
        out += "\\{";
        i += 1;
        continue;
      }
      out += braceFragment(pattern.slice(i + 1, end));
      i = end + 1;
    } else {
      out += "\\^$.|+()[]{}".includes(ch) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  return out;
}

function braceFragment(value: string): string {
  const alternatives = splitAlternatives(value);
  return alternatives.length < 2
    ? `\\{${globFragment(value)}\\}`
    : `(?:${alternatives.map(globFragment).join("|")})`;
}

function matchingBrace(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i += 1) {
    if (pattern[i] === "{") {
      depth += 1;
    } else if (pattern[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function splitAlternatives(value: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "{") {
      depth += 1;
    } else if (value[i] === "}") {
      depth -= 1;
    } else if (value[i] === "," && depth === 0) {
      alternatives.push(value.slice(start, i));
      start = i + 1;
    }
  }
  alternatives.push(value.slice(start));
  return alternatives;
}

// ── Matching ──
// The same grammar as `globFragment`, built as a nondeterministic state
// machine and run over every live state at once, one UTF-16 code unit at a
// time (as the regex, which has no `u` flag, reads the path).

/** One code unit, any code unit but `/`, or any code unit but a line
 *  terminator (what `.` takes without the `s` flag). */
type Accepts = string | "segment" | "any";

const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

interface GlobState {
  /** States reachable without reading anything. */
  readonly empty: number[];
  readonly steps: { readonly accepts: Accepts; readonly to: number }[];
}

interface GlobMachine {
  readonly accept: number;
  readonly states: readonly GlobState[];
}

function compileGlob(pattern: string): GlobMachine {
  const builder = new GlobBuilder();
  return {
    accept: builder.fragment(pattern, builder.add()),
    states: builder.states,
  };
}

/** Thompson-style construction; state 0 is the start. */
class GlobBuilder {
  readonly states: GlobState[] = [];

  add(): number {
    return this.states.push({ empty: [], steps: [] }) - 1;
  }

  /** States from `start` through `source`; returns where it ends. */
  fragment(source: string, start: number): number {
    let at = start;
    let i = 0;
    while (i < source.length) {
      const wildcard = this.#wildcard(source, i, at);
      if (wildcard) {
        [at, i] = wildcard;
        continue;
      }
      const end = source[i] === "{" ? matchingBrace(source, i) : -1;
      if (end === -1) {
        at = this.#literal(at, source.charAt(i));
        i += 1;
      } else {
        at = this.#braces(source.slice(i + 1, end), at);
        i = end + 1;
      }
    }
    return at;
  }

  /** `**` + `/`, `**`, `*`, or `?` at `i`: the state after it and the next index. */
  #wildcard(
    source: string,
    i: number,
    from: number
  ): [at: number, next: number] | undefined {
    if (source.startsWith("**/", i)) {
      // Zero or more `name/` directories.
      const at = this.#fresh(from);
      const name = this.add();
      this.#step(at, "segment", name);
      this.#step(name, "segment", name);
      this.#step(name, "/", at);
      return [at, i + 3];
    }
    if (source.startsWith("**", i)) {
      const at = this.#fresh(from);
      this.#step(at, "any", at);
      return [at, i + 2];
    }
    if (source[i] === "*") {
      const at = this.#fresh(from);
      this.#step(at, "segment", at);
      return [at, i + 1];
    }
    if (source[i] === "?") {
      const at = this.add();
      this.#step(from, "segment", at);
      return [at, i + 1];
    }
  }

  #braces(value: string, from: number): number {
    const alternatives = splitAlternatives(value);
    if (alternatives.length < 2) {
      return this.#literal(this.fragment(value, this.#literal(from, "{")), "}");
    }
    const end = this.add();
    for (const alternative of alternatives) {
      this.#state(this.fragment(alternative, this.#fresh(from))).empty.push(
        end
      );
    }
    return end;
  }

  #literal(from: number, ch: string): number {
    const to = this.add();
    this.#step(from, ch, to);
    return to;
  }

  /** A new state reached by an empty move, so a repetition never mixes with
   *  the one before it. */
  #fresh(from: number): number {
    const to = this.add();
    this.#state(from).empty.push(to);
    return to;
  }

  #step(from: number, accepts: Accepts, to: number): void {
    this.#state(from).steps.push({ accepts, to });
  }

  #state(index: number): GlobState {
    return this.states[index] as GlobState;
  }
}

function runGlob(machine: GlobMachine, text: string): boolean {
  const { accept, states } = machine;
  const reach = (from: Iterable<number>): Set<number> => {
    const reached = new Set<number>();
    const pending = [...from];
    for (
      let index = pending.pop();
      index !== undefined;
      index = pending.pop()
    ) {
      if (!reached.has(index)) {
        reached.add(index);
        // A loop, not a spread: a brace with very many alternatives would
        // pass more arguments than one call takes.
        for (const target of states[index]?.empty ?? []) {
          pending.push(target);
        }
      }
    }
    return reached;
  };

  let live = reach([0]);
  for (const unit of text.split("")) {
    const next: number[] = [];
    for (const index of live) {
      for (const { accepts, to } of states[index]?.steps ?? []) {
        if (
          accepts === unit ||
          (accepts === "any" && !LINE_TERMINATORS.has(unit)) ||
          (accepts === "segment" && unit !== "/")
        ) {
          next.push(to);
        }
      }
    }
    live = reach(next);
    if (live.size === 0) {
      return false;
    }
  }
  return live.has(accept);
}
