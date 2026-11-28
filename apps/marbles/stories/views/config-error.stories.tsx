import { defineStories, story } from "textbook-sh";
import { ConfigErrorView } from "~/tui/views/config-error";
import { ignore } from "../frame";
import { renderReactStory } from "../render-react-story";

const moduleError =
  "A marble module could not load. Check its imports and syntax.";

const longError = [
  "Could not load .foundry/marbles/docs.ts:",
  "SyntaxError: Unexpected token '}' at line 42, column 3.",
  "",
  "The module was imported by .foundry/marbles/index.ts, which Marbles reads first. Fix the module and start Marbles again; nothing else was loaded, so no schedule or monitor is running.",
].join("\n");

export default defineStories({
  component: "ConfigErrorView",
  description:
    "Shown when the workspace's Marbles source fails to load; Enter, Esc, or q closes it.",
  title: "Views/ConfigError",
});

export const Default = story({
  description: "A short load error.",
  name: "Default",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <ConfigErrorView message={moduleError} onClose={ignore} />
    ),
});

export const LongMessage = story({
  description: "A multi-line error that wraps inside the frame.",
  name: "Long message",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <ConfigErrorView message={longError} onClose={ignore} />
    ),
});
