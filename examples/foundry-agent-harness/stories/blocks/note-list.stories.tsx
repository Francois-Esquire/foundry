import { defineStories, story } from "textbook-sh";
import { NoteList } from "@/components/blocks/note-list";
import { threads } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 8, width: 44 };

export default defineStories({
  component: "NoteList",
  description: "The artifact version a goal was kept as, and its files.",
  title: "Blocks/NoteList",
});

export const Empty = story({
  description: "Nothing has been kept yet.",
  name: "Empty",
  render: (renderer) =>
    renderFrame(renderer, <NoteList notes={undefined} />, size),
});

export const Kept = story({
  description: "One version holding a file per task.",
  name: "Kept",
  render: (renderer) =>
    renderFrame(renderer, <NoteList notes={threads.done.notes} />, size),
});
