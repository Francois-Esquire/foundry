import type { FileKind } from "./types";

// The one place a path becomes a file kind. Churn, hotspots, concept
// centers, module nodes, and plans all read this; none may re-derive it.

const CONFIG_FILE =
  /(^|\/)(package\.json|tsconfig[^/]*\.json|turbo\.json|knip\.json|bunfig\.toml|[^/]*\.config\.[cm]?[jt]sx?|\.[^/]+)$/;
const TEST_FILE =
  /(^|\/)(test|tests|__tests__|__mocks__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
/** Storybook stories and anything kept under a `stories/` directory. */
const STORY_FILE = /(^|\/)stories\/|\.stories\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

export function classifyFile(file: string): FileKind {
  if (CONFIG_FILE.test(file)) {
    return "config";
  }
  if (TEST_FILE.test(file)) {
    return "test";
  }
  if (STORY_FILE.test(file)) {
    return "story";
  }
  if (SOURCE_FILE.test(file)) {
    return "source";
  }
  return "other";
}
