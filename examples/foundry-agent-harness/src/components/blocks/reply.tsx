import { SyntaxStyle } from "@opentui/core";
import { useMemo } from "react";
import { useTheme } from "@/hooks/use-theme";

const BLANK_LINES_INSIDE_FENCE = /\n(\n```)|(?<=```\n)\n/g;

export function Reply({
  markdown,
  streaming,
}: {
  readonly markdown: string;
  readonly streaming: boolean;
}) {
  const theme = useTheme();
  const style = useMemo(
    () =>
      SyntaxStyle.fromStyles({
        conceal: { fg: theme.colors.mutedForeground },
        default: { fg: theme.colors.foreground },
        "markup.heading": { bold: true, fg: theme.colors.primary },
        "markup.link": { fg: theme.colors.info, underline: true },
        "markup.list": { fg: theme.colors.accent },
        "markup.raw": { fg: theme.colors.warning },
        "markup.raw.block": { fg: theme.colors.info },
        "markup.strong": { bold: true },
      }),
    [theme]
  );
  return (
    <markdown
      conceal
      content={markdown.replace(BLANK_LINES_INSIDE_FENCE, "$1")}
      streaming={streaming}
      syntaxStyle={style}
    />
  );
}
