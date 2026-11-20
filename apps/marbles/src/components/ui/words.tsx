import { theme } from "./theme";

const SPACES = /\s+/;

const SEPARATOR = "·";

function tokens(text: string): readonly { key: string; word: string }[] {
  const words: string[] = [];
  for (const word of text.split(SPACES)) {
    if (word === "") {
      continue;
    }
    if (word === SEPARATOR && words.length > 0) {
      words[words.length - 1] = `${words.at(-1)} ${SEPARATOR}`;
    } else {
      words.push(word);
    }
  }
  const seen = new Map<string, number>();
  return words.map((word) => {
    const count = seen.get(word) ?? 0;
    seen.set(word, count + 1);
    return { key: `${word}#${count}`, word };
  });
}

export function Words({
  children,
  fg = theme.colors.foreground,
  indent = 0,
}: {
  readonly children: string;
  readonly fg?: string;
  readonly indent?: number;
}) {
  return (
    <box
      columnGap={1}
      flexDirection="row"
      flexShrink={1}
      flexWrap="wrap"
      minWidth={0}
      paddingLeft={indent}
    >
      {tokens(children).map(({ key, word }) => (
        <text fg={fg} flexShrink={1} key={key} minWidth={0} wrapMode="char">
          {word}
        </text>
      ))}
    </box>
  );
}
