import { SyntaxStyle } from "@opentui/core";
import { useCallback, useEffect, useMemo } from "react";
import { Action } from "~/components/action";
import { FeedMetaLine } from "~/components/feed-meta";
import { Panel } from "~/components/panel";
import type { Theme } from "~/components/ui/types";
import { useTheme } from "~/hooks/use-theme";
import type {
  FeedEntrySnapshot,
  FeedMediaSnapshot,
} from "~/views/dashboard-model";
import type { AnswerState } from "~/views/use-feed";
import { EmptyState } from "./empty-state";

const IMAGE_HEIGHT = 14;
const IMAGE_WIDTH = 56;
const MEDIA_ICON = { audio: "♪", file: "□", image: "▣", video: "▶" } as const;

/** Markdown scopes from OpenTUI's Tree-sitter grammar, in the theme's colors. */
function markdownStyle(theme: Theme): SyntaxStyle {
  const { colors } = theme;
  return SyntaxStyle.fromStyles({
    comment: { fg: colors.mutedForeground, italic: true },
    conceal: { fg: colors.mutedForeground },
    default: { fg: colors.foreground },
    function: { fg: colors.info },
    keyword: { fg: colors.secondary },
    "markup.heading": { bold: true, fg: colors.primary },
    "markup.heading.1": { bold: true, fg: colors.primary, underline: true },
    "markup.italic": { italic: true },
    "markup.link": { fg: colors.info, underline: true },
    "markup.link.label": { fg: colors.info },
    "markup.link.url": { fg: colors.info, underline: true },
    "markup.list": { fg: colors.accent },
    "markup.quote": { fg: colors.mutedForeground, italic: true },
    "markup.raw": { fg: colors.accent },
    "markup.raw.block": { fg: colors.foreground },
    "markup.strikethrough": { dim: true },
    "markup.strong": { bold: true },
    number: { fg: colors.warning },
    string: { fg: colors.success },
    type: { fg: colors.info },
  });
}

function MediaItem({ media }: { readonly media: FeedMediaSnapshot }) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <text fg={theme.colors.mutedForeground} wrapMode="none">
        {MEDIA_ICON[media.kind]} {media.path}
      </text>
      {media.kind === "image" && media.bytes && (
        <image
          fit="fit"
          height={IMAGE_HEIGHT}
          protocol="auto"
          source={media.bytes}
          width={IMAGE_WIDTH}
        />
      )}
    </box>
  );
}

function Choices({
  choices,
  onChoose,
  enabled,
}: {
  readonly choices: readonly string[];
  readonly onChoose: (choice: string) => void;
  readonly enabled: boolean;
}) {
  return (
    <box flexDirection="row" flexShrink={0} flexWrap="wrap" gap={3}>
      {choices.map((choice, index) => (
        <Action
          active={enabled}
          id={`answer:${index + 1}`}
          key={choice}
          label={`${index + 1} ${choice}`}
          onAction={onChoose}
          value={choice}
        />
      ))}
    </box>
  );
}

/** What a paused run is waiting for, and how to give it. */
function AnswerSection({
  entry,
  answer,
}: {
  readonly entry: FeedEntrySnapshot;
  readonly answer: AnswerState;
}) {
  const theme = useTheme();
  const choose = useCallback(
    (choice: string) => {
      answer.choose(choice);
    },
    [answer.choose]
  );
  const { input } = entry;
  if (!input) {
    return null;
  }
  if (input.status === "answered") {
    return (
      <text fg={theme.colors.success} flexShrink={0} paddingTop={1}>
        ✓ Answered: <strong>{input.answer ?? ""}</strong>
        {input.note ? ` — ${input.note}` : ""}
      </text>
    );
  }
  if (input.status === "cancelled") {
    return (
      <text fg={theme.colors.mutedForeground} flexShrink={0} paddingTop={1}>
        No longer waiting: the run stopped before an answer.
      </text>
    );
  }
  const elsewhere = answer.question ? undefined : (
    <text fg={theme.colors.mutedForeground}>
      Answer from the dashboard that started this run.
    </text>
  );
  let control = elsewhere;
  if (answer.typing) {
    control = (
      <box flexDirection="row" height={1}>
        <text fg={theme.colors.foreground}>
          {answer.choosing ? `${answer.choosing} · note › ` : "› "}
        </text>
        <input
          backgroundColor={theme.colors.muted}
          cursorColor={theme.colors.primary}
          flexGrow={1}
          focused
          focusedBackgroundColor={theme.colors.muted}
          focusedTextColor={theme.colors.foreground}
          onInput={answer.setDraft}
          onSubmit={answer.submitDraft}
          textColor={theme.colors.foreground}
          value={answer.draft}
        />
      </box>
    );
  } else if (input.choices.length > 0) {
    control = (
      <Choices
        choices={input.choices}
        enabled={answer.question !== undefined}
        onChoose={choose}
      />
    );
  } else if (answer.question) {
    control = (
      <text fg={theme.colors.mutedForeground}>a to type an answer</text>
    );
  }
  return (
    <box
      border
      borderColor={theme.colors.warning}
      borderStyle="rounded"
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      paddingX={1}
      title="Needs your input"
    >
      {control}
      {input.choices.length > 0 && elsewhere}
      {answer.typing && (
        <text fg={theme.colors.mutedForeground}>
          {answer.choosing
            ? "note optional · Enter send · Esc cancel"
            : "Enter send · Esc cancel"}
        </text>
      )}
      {answer.sending && <text fg={theme.colors.info}>Sending…</text>}
      {answer.error && <text fg={theme.colors.error}>{answer.error}</text>}
    </box>
  );
}

export function FeedReader({
  entry,
  active,
  answer,
}: {
  readonly entry?: FeedEntrySnapshot;
  readonly active: boolean;
  readonly answer: AnswerState;
}) {
  const theme = useTheme();
  const style = useMemo(() => markdownStyle(theme), [theme]);
  useEffect(() => () => style.destroy(), [style]);
  if (!entry) {
    return (
      <Panel active={active} title="Entry">
        <EmptyState
          description="Select an entry to read it here."
          title="Nothing selected."
        />
      </Panel>
    );
  }
  return (
    <Panel
      active={active}
      id="panel:entry"
      resetKey={entry.id}
      scrollable={active}
      title={
        active ? "Entry · ↑↓ scroll · Esc entries" : "Entry · Enter to read"
      }
    >
      <box flexDirection="row" flexShrink={0}>
        <FeedMetaLine
          details={[entry.workspace.name, entry.posted, entry.run, entry.step]}
          entry={entry}
        />
      </box>
      <markdown
        conceal
        content={entry.body}
        flexShrink={0}
        paddingTop={1}
        syntaxStyle={style}
      />
      <AnswerSection answer={answer} entry={entry} />
      {entry.media.length > 0 && (
        <box flexDirection="column" flexShrink={0} paddingTop={1}>
          <text fg={theme.colors.foreground}>
            <strong>Media</strong>
          </text>
          {entry.media.map((media) => (
            <MediaItem key={media.path} media={media} />
          ))}
        </box>
      )}
    </Panel>
  );
}
