import type { FileKind } from "./types";

const CONFIG_FILE =
  /(^|\/)(package\.json|tsconfig[^/]*\.json|turbo\.json|knip\.json|bunfig\.toml|[^/]*\.config\.[cm]?[jt]sx?|\.[^/]+)$/;
const TEST_FILE =
  /(^|\/)(test|tests|__tests__|__mocks__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
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
