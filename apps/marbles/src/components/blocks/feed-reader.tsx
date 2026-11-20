import { SyntaxStyle } from "@opentui/core";
import { useEffect, useMemo } from "react";
import { FeedMetaLine } from "~/components/blocks/feed-meta";
import { Action } from "~/components/ui/action";
import { Panel } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { TextInput } from "~/components/ui/text-input";
import { theme } from "~/components/ui/theme";
import type { FeedMediaSnapshot } from "~/lib/feed/read";
import { EmptyState } from "./empty-state";
import type { FeedItem } from "./feed-list";

export interface AnswerChoice {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface AnswerDelivery {
  readonly error?: string;
  readonly sending: boolean;
}

export type AnswerView =
  | {
      readonly answer: string;
      readonly kind: "answered";
      readonly note?: string;
    }
  | { readonly kind: "cancelled" }
  | (AnswerDelivery & {
      readonly choices: readonly AnswerChoice[];
      readonly kind: "choice";
      readonly onChoose: (choice: string) => void;
      readonly shortcut: string;
    })
  | (AnswerDelivery & {
      readonly choices: readonly AnswerChoice[];
      readonly kind: "unavailable";
    })
  | (AnswerDelivery & { readonly kind: "free-text" })
  | (AnswerDelivery & {
      readonly draft: string;
      readonly hint: string;
      readonly kind: "typing";
      readonly onInput: (value: string) => void;
      readonly onSubmit: () => void;
      readonly prompt: string;
    });

type OpenAnswer = Exclude<
  AnswerView,
  { readonly kind: "answered" | "cancelled" }
>;

export interface ReaderItem extends FeedItem {
  readonly answer?: AnswerView;
}

const IMAGE_HEIGHT = 14;
const IMAGE_WIDTH = 56;
const MEDIA_ICON = { audio: "♪", file: "□", image: "▣", video: "▶" } as const;

function markdownStyle(): SyntaxStyle {
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

const ignore = () => undefined;

function Choices({
  choices,
  onChoose,
  enabled,
}: {
  readonly choices: readonly AnswerChoice[];
  readonly onChoose: (choice: string) => void;
  readonly enabled: boolean;
}) {
  return (
    <box flexDirection="row" flexShrink={0} flexWrap="wrap" gap={3}>
      {choices.map((choice) => (
        <Action
          active={enabled}
          id={choice.id}
          key={choice.value}
          label={choice.label}
          onAction={onChoose}
          value={choice.value}
        />
      ))}
    </box>
  );
}

function AnswerElsewhere() {
  return (
    <text fg={theme.colors.mutedForeground}>
      Answer from the dashboard that started this run.
    </text>
  );
}

function AnswerControl({ answer }: { readonly answer: OpenAnswer }) {
  switch (answer.kind) {
    case "typing":
      return (
        <>
          <box flexDirection="row" height={1}>
            <Text>{answer.prompt}</Text>
            <TextInput
              flexGrow={1}
              focused
              onInput={answer.onInput}
              onSubmit={answer.onSubmit}
              value={answer.draft}
            />
          </box>
          <text fg={theme.colors.mutedForeground}>{answer.hint}</text>
        </>
      );
    case "choice":
      return (
        <Choices choices={answer.choices} enabled onChoose={answer.onChoose} />
      );
    case "unavailable":
      return (
        <>
          {answer.choices.length > 0 && (
            <Choices
              choices={answer.choices}
              enabled={false}
              onChoose={ignore}
            />
          )}
          <AnswerElsewhere />
        </>
      );
    default:
      return <text fg={theme.colors.mutedForeground}>a to type an answer</text>;
  }
}

function AnswerSection({ answer }: { readonly answer: AnswerView }) {
  if (answer.kind === "answered") {
    return (
      <text fg={theme.colors.success} flexShrink={0} paddingTop={1}>
        ✓ Answered: <strong>{answer.answer}</strong>
        {answer.note ? ` — ${answer.note}` : ""}
      </text>
    );
  }
  if (answer.kind === "cancelled") {
    return (
      <text fg={theme.colors.mutedForeground} flexShrink={0} paddingTop={1}>
        No longer waiting: the run stopped before an answer.
      </text>
    );
  }
  return (
    <box
      border
      borderColor={theme.colors.warning}
      borderStyle="rounded"
      bottomTitle={answer.kind === "choice" ? answer.shortcut : undefined}
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      paddingX={1}
      title="Needs your input"
    >
      <AnswerControl answer={answer} />
      {answer.sending && <text fg={theme.colors.info}>Sending…</text>}
      {answer.error && <text fg={theme.colors.error}>{answer.error}</text>}
    </box>
  );
}

export function FeedReader({
  selected,
  active,
}: {
  readonly selected?: ReaderItem;
  readonly active: boolean;
}) {
  const style = useMemo(markdownStyle, []);
  useEffect(() => () => style.destroy(), [style]);
  if (!selected) {
    return (
      <Panel active={active} title="Entry">
        <EmptyState
          description="Select an entry to read it here."
          title="Nothing selected."
        />
      </Panel>
    );
  }
  const { entry } = selected;
  return (
    <Panel
      active={active}
      id="panel:entry"
      resetKey={selected.key}
      scrollable={active}
      title={
        active ? "Entry · ↑↓ scroll · Esc entries" : "Entry · Enter to read"
      }
    >
      <box flexDirection="row" flexShrink={0}>
        <FeedMetaLine
          details={[entry.workspace.name, entry.posted, entry.run, entry.step]}
          meta={selected.meta}
        />
      </box>
      <markdown
        conceal
        content={entry.body}
        flexShrink={0}
        paddingTop={1}
        syntaxStyle={style}
      />
      {selected.answer && <AnswerSection answer={selected.answer} />}
      {entry.media.length > 0 && (
        <box flexDirection="column" flexShrink={0} paddingTop={1}>
          <Text>
            <strong>Media</strong>
          </Text>
          {entry.media.map((media) => (
            <MediaItem key={media.path} media={media} />
          ))}
        </box>
      )}
    </Panel>
  );
}
