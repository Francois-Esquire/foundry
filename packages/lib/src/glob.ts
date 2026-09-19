/** Compile one glob to a regex over a POSIX path. `**` crosses separators
 * (`**` before a slash matches zero or more directories), `*`/`?` do not,
 * and `{ts,tsx}` selects one of several alternatives. */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globFragment(pattern)}$`);
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
