export interface Frontmatter {
  body: string;
  data: Record<string, string>;
}

export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) {
    return { body: src, data: {} };
  }

  const close = src.indexOf("\n---", 3);
  if (close === -1) {
    return { body: src, data: {} };
  }

  const block = src.slice(4, close);
  const lineEnd = src.indexOf("\n", close + 1);
  const body = lineEnd === -1 ? "" : src.slice(lineEnd + 1);

  return { body, data: parseYamlBlock(block) };
}

export function parseYamlBlock(block: string): Record<string, string> {
  const data: Record<string, string> = {};
  const lines = block.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    const key = match?.[1];
    if (key === undefined) {
      continue;
    }
    const value = (match?.[2] ?? "").trim();

    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const folded = value.startsWith(">");
      const collected: string[] = [];
      const baseIndent = indentWidth(lines[i + 1] ?? "");
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next === undefined) {
          break;
        }
        if (next.trim() === "") {
          collected.push("");
          i++;
          continue;
        }
        if (indentWidth(next) < baseIndent) {
          break;
        }
        collected.push(next.slice(baseIndent));
        i++;
      }
      data[key] = folded
        ? collected.join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n").trim();
    } else {
      data[key] = unquote(value);
    }
  }

  return data;
}

function indentWidth(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

function unquote(value: string): string {
  const quote = value[0];
  if (
    value.length >= 2 &&
    (quote === '"' || quote === "'") &&
    value.endsWith(quote)
  ) {
    return value.slice(1, -1);
  }
  return value;
}
