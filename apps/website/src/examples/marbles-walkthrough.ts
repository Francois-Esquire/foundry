import source from "./marbles-assess.ts.txt?raw";

type Mode = "code" | "string" | "template";

interface Note {
  body: string;
  marks: string;
  title: string;
}

const keywords = /\b(import|from|const|async|await|return|if)\b/g;

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const code = (text: string): string =>
  escapeHtml(text).replace(keywords, '<span class="keyword">$1</span>');

const string = (text: string): string =>
  text ? `<span class="string">${escapeHtml(text)}</span>` : "";

const closes = (mode: Mode, char: string): boolean =>
  (mode === "string" && char === '"') || (mode === "template" && char === "`");

const opening = (char: string): Mode | undefined => {
  if (char === '"') {
    return "string";
  }
  if (char === "`") {
    return "template";
  }
};

const highlightLine = (
  line: string,
  startMode: Mode
): { html: string; mode: Mode } => {
  if (startMode === "code" && line.trimStart().startsWith("//")) {
    return {
      html: `<span class="comment">${escapeHtml(line)}</span>`,
      mode: "code",
    };
  }
  let html = "";
  let buffer = "";
  let mode = startMode;
  for (const char of line) {
    const opened = mode === "code" ? opening(char) : undefined;
    if (opened) {
      html += code(buffer);
      buffer = char;
      mode = opened;
    } else if (mode !== "code" && closes(mode, char)) {
      html += string(buffer + char);
      buffer = "";
      mode = "code";
    } else {
      buffer += char;
    }
  }
  html += mode === "code" ? code(buffer) : string(buffer);
  return { html, mode: mode === "template" ? "template" : "code" };
};

export const notes: Note[] = [
  {
    body: "Another workflow appends reports to <code>incidents.md</code>.",
    marks: "// Another workflow",
    title: "One workflow leaves a note.",
  },
  {
    body: "Codex reads the entry and answers in JSON. The step validates the answer before trusting it.",
    marks: "const triage = agent(",
    title: "An agent makes the judgment.",
  },
  {
    body: "An ordinary <code>if</code> finishes the run or writes an investigation brief.",
    marks: "if (!isIncident)",
    title: "Your code makes the decision.",
  },
  {
    body: "Marbles polls <code>incidents.md</code> and starts <code>assess</code> when it changes.",
    marks: 'monitor("incidents.md")',
    title: "A monitor starts it.",
  },
];

const markFor = (line: string): number | undefined => {
  const index = notes.findIndex((note) =>
    line.trimStart().startsWith(note.marks)
  );
  return index === -1 ? undefined : index + 1;
};

const renderLines = (): string => {
  let mode: Mode = "code";
  return source
    .trimEnd()
    .split("\n")
    .map((line, index) => {
      const { html, mode: nextMode } = highlightLine(line, mode);
      mode = nextMode;
      const mark = markFor(line);
      const badge = mark ? `<span class="code-mark">${mark}</span>` : "";
      const className = mark ? "code-line marked" : "code-line";
      return `<span class="${className}"><span class="code-gutter" aria-hidden="true"><span class="line-number">${index + 1}</span>${badge}</span><span class="code-text">${html || " "}</span></span>`;
    })
    .join("");
};

const unmarked = notes.filter(
  (note) =>
    !source.split("\n").some((line) => line.trimStart().startsWith(note.marks))
);
if (unmarked.length > 0) {
  throw new Error(
    `Marbles walkthrough notes point at missing lines: ${unmarked.map((note) => note.marks).join(", ")}`
  );
}

export const linesHtml = renderLines();
