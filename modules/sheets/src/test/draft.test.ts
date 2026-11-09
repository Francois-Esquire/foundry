import { expect, it } from "vitest";
import { answered, dirty, edit, observed, opened } from "../draft";
import { workbooks as Workbook } from "./helpers/workbooks";

const base = { contentId: "c1", digest: "d1" };
const A1 = { cell: "A1", sheet: "Sheet1" };

it("is clean again once an edit to the workbook is undone", () => {
  const workbook = Workbook.create();
  workbook.enter(A1, "=1+1");
  let draft = opened(base, workbook.toFile());

  workbook.enter(A1, "=1+2");
  draft = edit(draft, workbook.toFile());
  expect(dirty(draft)).toBe(true);

  workbook.enter(A1, "=1+1");
  draft = edit(draft, workbook.toFile());
  expect(dirty(draft)).toBe(false);
});

it("keeps the edited workbook when its save loses to another writer", () => {
  const mine = Workbook.create();
  const draft = opened(base, mine.toFile());
  mine.enter(A1, "mine");
  const sent = mine.toFile();
  const theirs = Workbook.create();
  theirs.enter(A1, "theirs");

  const lost = answered(edit(draft, sent), sent, {
    current: { digest: "d2", text: theirs.toFile() },
    kind: "conflict",
  });
  expect(dirty(lost)).toBe(true);
  expect(Workbook.open(lost.text).contents(A1)).toBe("mine");
  expect(Workbook.open(lost.conflict?.text ?? "").contents(A1)).toBe("theirs");
});

it("keeps a newer version reported during a save unless it is that save", () => {
  const draft = edit(opened(base, "saved"), "mine");
  const watched = (digest: string) =>
    observed(draft, {
      contentId: "c1",
      entry: { digest },
      kind: "change",
    }).draft;
  const saved = { digest: "d2", kind: "saved" } as const;

  expect(answered(watched("d3"), "mine", saved).newer).toEqual({
    contentId: "c1",
    digest: "d3",
  });
  expect(answered(watched("d2"), "mine", saved).newer).toBeNull();
  expect(answered(draft, "mine", saved).newer).toBeNull();
});
