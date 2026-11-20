import { defineStories, story } from "textbook-sh";
import { Badge } from "~/components/ui/badge";
import { renderFrame } from "./frame";

const size = { height: 3, width: 30 };

export default defineStories({
  component: "Badge",
  description:
    "A bold label on a solid tone, with black or white text by contrast.",
  title: "UI/Badge",
});

export const ErrorBadge = story({
  description: "The error tone.",
  name: "Error",
  render: (renderer) =>
    renderFrame(renderer, <Badge variant="error">FAILED</Badge>, size),
});

export const WarningBadge = story({
  description: "The warning tone.",
  name: "Warning",
  render: (renderer) =>
    renderFrame(renderer, <Badge variant="warning">WAITING</Badge>, size),
});
