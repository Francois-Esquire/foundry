import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { feedItem } from "~/cli/state/feed-model";
import {
  type AnswerChoice,
  type AnswerView,
  FeedReader,
  type ReaderItem,
} from "~/components/blocks/feed-reader";
import { Action } from "~/components/ui/action";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { ignore, renderFrame } from "../frame";
import {
  answeredEntry,
  cancelledEntry,
  freeTextEntry,
  longEntry,
  mediaEntry,
  milestoneEntry,
  pendingEntry,
  summaryEntry,
} from "./fixtures-a";

const size = { height: 22, padded: false, width: 72 };

const choices: readonly AnswerChoice[] = [
  { id: "answer:1", label: "1 merge", value: "merge" },
  { id: "answer:2", label: "2 hold", value: "hold" },
];

const PIXEL_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  ),
  (char) => char.charCodeAt(0)
);

function reader(entry: FeedEntrySnapshot, answer?: AnswerView): ReaderItem {
  return { ...feedItem(entry), ...(answer ? { answer } : {}) };
}

function Reader({
  active = true,
  item,
}: {
  readonly active?: boolean;
  readonly item?: ReaderItem;
}) {
  return <FeedReader active={active} selected={item} />;
}

function AnsweringReader() {
  const [chosen, setChosen] = useState<string>();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string>();
  const submit = useCallback(() => setNote(draft), [draft]);
  const reset = useCallback(() => {
    setChosen(undefined);
    setDraft("");
    setNote(undefined);
  }, []);
  let answer: AnswerView;
  if (chosen === undefined) {
    answer = {
      choices,
      kind: "choice",
      onChoose: setChosen,
      sending: false,
      shortcut: " 1-2 answer ",
    };
  } else if (note === undefined) {
    answer = {
      draft,
      focused: true,
      hint: "note optional · Enter send · Esc cancel",
      kind: "typing",
      onInput: setDraft,
      onSubmit: submit,
      prompt: `${chosen} · note › `,
      sending: false,
    };
  } else {
    answer = {
      answer: chosen,
      kind: "answered",
      ...(note ? { note } : {}),
    };
  }
  return (
    <box flexDirection="column" flexGrow={1}>
      <Reader item={reader(pendingEntry, answer)} />
      <box flexShrink={0} paddingX={1}>
        <Action
          id="feed-reader-story:reset"
          label="[ Ask again ]"
          onAction={reset}
          value="reset"
        />
      </box>
    </box>
  );
}

export default defineStories({
  component: "FeedReader",
  description:
    "The selected feed entry: its meta line, Markdown body, answer section, and media.",
  title: "Blocks/FeedReader",
});

export const NothingSelected = story({
  description: "No entry selected yet; the panel invites a selection.",
  name: "Nothing selected",
  render: (renderer) => renderFrame(renderer, <Reader />, size),
});

export const Result = story({
  description:
    "A focused result entry with headings, a list, and a code block in its body.",
  name: "Result",
  render: (renderer) =>
    renderFrame(renderer, <Reader item={reader(summaryEntry)} />, size),
});

export const Inactive = story({
  description:
    "The same entry while the list has focus; the title says Enter reads it.",
  name: "Inactive",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader active={false} item={reader(summaryEntry)} />,
      size
    ),
});

export const Milestone = story({
  description: "A milestone entry with no answer section and no media.",
  name: "Milestone",
  render: (renderer) =>
    renderFrame(renderer, <Reader item={reader(milestoneEntry)} />, size),
});

export const Choice = story({
  description:
    "A question with choices this dashboard can answer; the border shows the number keys.",
  name: "Answer: choice",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader
        item={reader(pendingEntry, {
          choices,
          kind: "choice",
          onChoose: ignore,
          sending: false,
          shortcut: " 1-2 answer ",
        })}
      />,
      size
    ),
});

export const Sending = story({
  description: "A choice on its way to the run.",
  name: "Answer: sending",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader
        item={reader(pendingEntry, {
          choices,
          kind: "choice",
          onChoose: ignore,
          sending: true,
          shortcut: " 1-2 answer ",
        })}
      />,
      size
    ),
});

export const DeliveryError = story({
  description: "A choice the run refused, with the error under the choices.",
  name: "Answer: delivery error",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader
        item={reader(pendingEntry, {
          choices,
          error: "The run stopped waiting before the answer arrived.",
          kind: "choice",
          onChoose: ignore,
          sending: false,
          shortcut: " 1-2 answer ",
        })}
      />,
      size
    ),
});

export const FreeText = story({
  description: "A question with no choices; a key opens the answer field.",
  name: "Answer: free text",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader
        item={reader(freeTextEntry, { kind: "free-text", sending: false })}
      />,
      size
    ),
});

export const Typing = story({
  description: "A free-text answer part way through typing, with its hint.",
  name: "Answer: typing",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader
        item={reader(freeTextEntry, {
          draft: "Marbles 0.4 · Lantern",
          focused: true,
          hint: "Enter send · Esc cancel",
          kind: "typing",
          onInput: ignore,
          onSubmit: ignore,
          prompt: "› ",
          sending: false,
        })}
      />,
      size
    ),
});

export const Unavailable = story({
  description:
    "A question another dashboard started; its choices are shown but disabled.",
  name: "Answer: unavailable",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader
        item={reader(pendingEntry, {
          choices,
          kind: "unavailable",
          sending: false,
        })}
      />,
      size
    ),
});

export const UnavailableFreeText = story({
  description:
    "A free-text question another dashboard started; only the pointer to it shows.",
  name: "Answer: unavailable, no choices",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader
        item={reader(freeTextEntry, {
          choices: [],
          kind: "unavailable",
          sending: false,
        })}
      />,
      size
    ),
});

export const Answered = story({
  description: "An answered question with the note sent alongside it.",
  name: "Answer: answered",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader
        item={reader(answeredEntry, {
          answer: "merge",
          kind: "answered",
          note: "Looks good, ship it.",
        })}
      />,
      size
    ),
});

export const AnsweredWithoutNote = story({
  description: "An answered question with no note.",
  name: "Answer: answered, no note",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader
        item={reader(answeredEntry, { answer: "hold", kind: "answered" })}
      />,
      size
    ),
});

export const Cancelled = story({
  description: "A question whose run stopped before anyone answered.",
  name: "Answer: cancelled",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader item={reader(cancelledEntry, { kind: "cancelled" })} />,
      size
    ),
});

export const Answering = story({
  description:
    "A working answer: click a choice, type a note, press Enter; Ask again resets it.",
  name: "Answer interactively",
  render: (renderer) => renderFrame(renderer, <AnsweringReader />, size),
});

export const Media = story({
  description:
    "An entry with an image, video, audio, and file; the image has no bytes, so only its path shows.",
  name: "Media",
  render: (renderer) =>
    renderFrame(renderer, <Reader item={reader(mediaEntry)} />, {
      ...size,
      height: 30,
    }),
});

export const InlineImage = story({
  description:
    "An image entry with its bytes, drawn inline where the terminal supports images.",
  name: "Inline image",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Reader
        item={reader({
          ...mediaEntry,
          id: "feed-chart",
          media: [
            {
              bytes: PIXEL_PNG,
              kind: "image",
              name: "pixel.png",
              path: "media/pixel.png",
            },
          ],
          title: "Chart",
        })}
      />,
      { ...size, height: 30 }
    ),
});

export const LongBody = story({
  description: "A body taller than the panel; arrows scroll it while focused.",
  name: "Long body",
  render: (renderer) =>
    renderFrame(renderer, <Reader item={reader(longEntry)} />, size),
});

export const Narrow = story({
  description: "A result in a narrow panel; the meta line and body wrap.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(renderer, <Reader item={reader(summaryEntry)} />, {
      ...size,
      width: 36,
    }),
});
