export type FrontmatterData = Partial<Record<string, string>>;

export interface Frontmatter {
  body: string;
  data: FrontmatterData;
}

const WINDOWS_NEWLINE_PATTERN = /\r\n/g;
const FRONTMATTER_FIELD_PATTERN = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;
const INDENTATION_PATTERN = /^[ \t]*/;

export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(WINDOWS_NEWLINE_PATTERN, "\n");
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

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const match = FRONTMATTER_FIELD_PATTERN.exec(line);
    const key = match?.[1];
    if (key === undefined) {
      continue;
    }
    const value = (match?.[2] ?? "").trim();
    if (!isMultilineValue(value)) {
      data[key] = unquote(value);
      continue;
    }

    const multiline = collectMultilineValue(lines, i, value);
    data[key] = multiline.value;
    i = multiline.lastLine;
  }

  return data;
}

function isMultilineValue(value: string): boolean {
  return value === ">" || value === "|" || value === ">-" || value === "|-";
}

function collectMultilineValue(
  lines: string[],
  start: number,
  marker: string
): { lastLine: number; value: string } {
  const folded = marker.startsWith(">");
  const collected: string[] = [];
  const baseIndent = indentWidth(lines[start + 1] ?? "");
  let lastLine = start;

  while (lastLine + 1 < lines.length) {
    const next = lines[lastLine + 1];
    if (next === undefined) {
      break;
    }
    if (next.trim() === "") {
      collected.push("");
      lastLine += 1;
      continue;
    }
    if (indentWidth(next) < baseIndent) {
      break;
    }
    collected.push(next.slice(baseIndent));
    lastLine += 1;
  }

  const value = folded
    ? collected.join(" ").replace(/\s+/g, " ").trim()
    : collected.join("\n").trim();
  return { lastLine, value };
}

function indentWidth(line: string): number {
  return INDENTATION_PATTERN.exec(line)?.[0].length ?? 0;
}

function unquote(value: string): string {
  const [quote] = value;
  if (
    value.length >= 2 &&
    (quote === '"' || quote === "'") &&
    value.endsWith(quote)
  ) {
    return value.slice(1, -1);
  }
  return value;
}
