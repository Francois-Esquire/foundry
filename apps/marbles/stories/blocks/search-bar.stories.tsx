import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { RunFilterNotice, SearchBar } from "~/components/blocks/search-bar";
import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { ignore, renderFrame } from "../frame";

const size = { height: 5, width: 80 };

const runs = [
  "update-documentation",
  "check-api",
  "review-changes",
  "summarize-day",
];

function SearchRuns() {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(true);
  const apply = useCallback(() => setEditing(false), []);
  const clear = useCallback(() => setQuery(""), []);
  useKeyboard((key) => {
    if (editing && key.name === "escape") {
      key.preventDefault();
      setQuery("");
      setEditing(false);
    }
    if (!editing && key.name === "/") {
      key.preventDefault();
      setEditing(true);
    }
    if (!editing && key.name === "x") {
      key.preventDefault();
      setQuery("");
    }
  });
  const matches = runs.filter((name) => name.includes(query));
  return (
    <>
      <SearchBar
        editing={editing}
        focused={editing}
        onInput={setQuery}
        onSubmit={apply}
        query={query}
        scope="runs"
      />
      {!(editing || query) && (
        <text fg={theme.colors.mutedForeground}>No search · / starts one</text>
      )}
      {!editing && (
        <box flexDirection="row" gap={2}>
          <Action
            id="search-bar-story:edit"
            label="[ Edit ]"
            onAction={setEditing}
            value
          />
          <Action
            id="search-bar-story:clear"
            label="[ Clear ]"
            onAction={clear}
            value
          />
        </box>
      )}
      <Text>{matches.join(" · ") || "No matching runs."}</Text>
    </>
  );
}

export default defineStories({
  component: "SearchBar",
  description:
    "The search line above a list: an input while editing, a summary once applied.",
  title: "Blocks/SearchBar",
});

export const Search = story({
  description:
    "Type to filter; Enter keeps the query and Escape clears it; then / or Edit edits, x or Clear clears.",
  name: "Search",
  render: (renderer) =>
    renderFrame(renderer, <SearchRuns />, { height: 9, width: 80 }),
});

export const Editing = story({
  description: "Editing a query, focused.",
  name: "Editing",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SearchBar
        editing
        focused
        onInput={ignore}
        onSubmit={ignore}
        query="docs"
        scope="marbles"
      />,
      size
    ),
});

export const EditingUnfocused = story({
  description: "Editing, but focus is elsewhere, as under the quit dialog.",
  name: "Editing, unfocused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SearchBar
        editing
        focused={false}
        onInput={ignore}
        onSubmit={ignore}
        query="docs"
        scope="marbles"
      />,
      size
    ),
});

export const Applied = story({
  description: "An applied query, with the keys to edit or clear it.",
  name: "Applied",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SearchBar
        editing={false}
        focused={false}
        onInput={ignore}
        onSubmit={ignore}
        query="docs"
        scope="runs"
      />,
      size
    ),
});

export const Hidden = story({
  description: "No query and not editing renders nothing below the caption.",
  name: "Hidden",
  render: (renderer) =>
    renderFrame(
      renderer,
      <>
        <text fg={theme.colors.mutedForeground}>
          No search: nothing renders below this line.
        </text>
        <SearchBar
          editing={false}
          focused={false}
          onInput={ignore}
          onSubmit={ignore}
          query=""
          scope="runs"
        />
      </>,
      size
    ),
});

export const RunFilter = story({
  description:
    "The run filter notice, shown when runs are filtered to one item.",
  name: "Run filter notice",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunFilterNotice label="workflow: update-documentation" />,
      size
    ),
});

export const FilterAndSearch = story({
  description:
    "The run filter notice above an applied search, as on the dashboard.",
  name: "Filter and search",
  render: (renderer) =>
    renderFrame(
      renderer,
      <>
        <RunFilterNotice label="trigger: update-docs" />
        <SearchBar
          editing={false}
          focused={false}
          onInput={ignore}
          onSubmit={ignore}
          query="write"
          scope="runs"
        />
      </>,
      size
    ),
});
