import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { feedItem } from "../src/cli/state/feed-model";
import { FeedReader } from "../src/components/blocks/feed-reader";
import { PromptBar } from "../src/components/blocks/prompt-bar";
import { SearchBar } from "../src/components/blocks/search-bar";
import { fitInputRow } from "../src/components/ui/input-row";
import { pendingEntry } from "../stories/blocks/fixtures-a";
import { mount, type Rendered, unmount } from "./helpers/render";

const ignore = () => undefined;
const HINT = "Enter send · Esc cancel";
const STEER_WITH_HINT =
  /^steer write › Keep the existing examples +Enter send · Esc cancel$/;
const RESUME_WITH_HINT =
  /^resume write · prompt optional › Skip the changelog +Enter send · Esc cancel$/;
const SHORT_RESUME = /^resume updat.+te-changes › +changelog$/;
const LONG_QUERY_WITH_HINT =
  /^Search marbles: update documentation nightly digest +Enter apply · Esc clear$/;
const LABEL_THEN_QUERY = /^Search marbles: \S+/;
const ANSWER_LABEL_THEN_DRAFT = /│ merge · note › \S/;
const LONG_RESUME = [
  "resume update.write-changes · prompt optional ›",
  "resume update.write-changes ›",
];

let first: Rendered | undefined;

afterEach(async () => {
  await act(async () => {
    first?.renderer.destroy();
  });
  first = undefined;
  await unmount();
});

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

async function firstFrame(
  node: ReactNode,
  size: { readonly width: number; readonly height: number }
): Promise<string[]> {
  first = await testRender(node, size);
  await first.renderOnce();
  return lines(first.captureCharFrame());
}

describe("fitInputRow", () => {
  test("shows the hint only when the full label, a gap, the input and a gap fit", () => {
    const labels = ["steer write ›"];
    expect(fitInputRow(labels, HINT, 50)).toEqual({
      label: "steer write ›",
      showsHint: true,
    });
    expect(fitInputRow(labels, HINT, 49)).toEqual({
      label: "steer write ›",
      showsHint: false,
    });
  });

  test("takes the shorter label once the full one leaves no room for the input", () => {
    expect(fitInputRow(LONG_RESUME, HINT, 60).label).toBe(LONG_RESUME[0]);
    expect(fitInputRow(LONG_RESUME, HINT, 59).label).toBe(LONG_RESUME[1]);
    expect(fitInputRow(LONG_RESUME, HINT, 59).showsHint).toBe(false);
    expect(fitInputRow(LONG_RESUME, HINT, 84).showsHint).toBe(true);
    expect(fitInputRow(LONG_RESUME, HINT, 83).showsHint).toBe(false);
  });

  test("keeps the last label when nothing fits and trims trailing spaces", () => {
    expect(fitInputRow(LONG_RESUME, HINT, 20).label).toBe(LONG_RESUME[1]);
    expect(fitInputRow(["› "], undefined, 40)).toEqual({
      label: "›",
      showsHint: false,
    });
  });

  test("an unmeasured row shows the full label without the hint", () => {
    expect(fitInputRow(LONG_RESUME, HINT, 0)).toEqual({
      label: LONG_RESUME[0],
      showsHint: false,
    });
  });
});

test("a prompt bar shows its hint on the very first frame", async () => {
  const [row] = await firstFrame(
    <PromptBar
      draft="Keep the existing examples"
      focused
      kind="steer"
      onInput={ignore}
      onSubmit={ignore}
      stepId="write"
    />,
    { height: 3, width: 78 }
  );
  expect(row).toMatch(STEER_WITH_HINT);
});

test("a resume prompt with a short step shows the note and the hint on its first frame", async () => {
  const [row] = await firstFrame(
    <PromptBar
      draft="Skip the changelog"
      focused
      kind="resume"
      onInput={ignore}
      onSubmit={ignore}
      stepId="write"
    />,
    { height: 3, width: 78 }
  );
  expect(row).toMatch(RESUME_WITH_HINT);
});

test("a resume prompt with a long step at 80 columns has no room for the hint", async () => {
  const [row] = await firstFrame(
    <PromptBar
      draft="Skip the changelog"
      focused
      kind="resume"
      onInput={ignore}
      onSubmit={ignore}
      stepId="update.write-changes"
    />,
    { height: 3, width: 80 }
  );
  expect(row).toBe(
    "resume update.write-changes · prompt optional › Skip the changelog"
  );
});

test("a narrow resume prompt drops the note on its first frame", async () => {
  const [row] = await firstFrame(
    <PromptBar
      draft="Skip the changelog"
      focused
      kind="resume"
      onInput={ignore}
      onSubmit={ignore}
      stepId="update.write-changes"
    />,
    { height: 3, width: 40 }
  );
  expect(row).not.toContain("optional");
  expect(row).toMatch(SHORT_RESUME);
});

test("a prompt bar opened later shows its hint on its first frame", async () => {
  let open: (value: boolean) => void = ignore;
  function Later() {
    const [shown, setShown] = useState(false);
    open = setShown;
    return shown ? (
      <PromptBar
        draft="Keep the existing examples"
        focused
        kind="steer"
        onInput={ignore}
        onSubmit={ignore}
        stepId="write"
      />
    ) : (
      <text>closed</text>
    );
  }
  await firstFrame(<Later />, { height: 3, width: 78 });
  await act(async () => {
    open(true);
  });
  await first?.renderOnce();
  const [row] = lines(first?.captureCharFrame() ?? "");
  expect(row).toMatch(STEER_WITH_HINT);
});

test("a narrow search bar drops the hint and keeps the label apart from the query", async () => {
  const [row] = await firstFrame(
    <SearchBar
      editing
      focused
      onInput={ignore}
      onSubmit={ignore}
      query="docs"
      scope="marbles"
    />,
    { height: 3, width: 44 }
  );
  expect(row).toBe("Search marbles: docs");
});

test("a long query that fits is shown whole beside the label and the hint", async () => {
  const [row] = await firstFrame(
    <SearchBar
      editing
      focused
      onInput={ignore}
      onSubmit={ignore}
      query="update documentation nightly digest"
      scope="marbles"
    />,
    { height: 3, width: 80 }
  );
  expect(row).toMatch(LONG_QUERY_WITH_HINT);
});

test("a long query in a narrow search bar leaves the label whole", async () => {
  const [row] = await firstFrame(
    <SearchBar
      editing
      focused
      onInput={ignore}
      onSubmit={ignore}
      query="update documentation nightly digest"
      scope="marbles"
    />,
    { height: 3, width: 44 }
  );
  expect(row).toMatch(LABEL_THEN_QUERY);
  expect(row).not.toContain("Enter");
});

test("a long typed answer in a narrow feed reader keeps its label", async () => {
  const ui = await mount(
    <FeedReader
      active
      selected={{
        ...feedItem(pendingEntry),
        answer: {
          draft:
            "Ship it after the nightly digest finishes and the docs are rebuilt",
          focused: true,
          hint: "Enter send · Esc cancel",
          kind: "typing",
          onInput: ignore,
          onSubmit: ignore,
          prompt: "merge · note › ",
          sending: false,
        },
      }}
    />,
    { height: 30, width: 40 }
  );
  const frame = lines(ui.captureCharFrame());
  expect(frame.some((line) => ANSWER_LABEL_THEN_DRAFT.test(line))).toBe(true);
});

test("a wide-character label is measured in cells", () => {
  const label = "界".repeat(10);
  const hint = "Enter send · Esc cancel";
  expect(fitInputRow([label], hint, 50)).toEqual({ label, showsHint: false });
  expect(fitInputRow([label], hint, 20 + 1 + 12 + 1 + 23)).toEqual({
    label,
    showsHint: true,
  });
});
