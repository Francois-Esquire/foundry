import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSessionStore } from "@foundry/agents/testing";
import { afterAll } from "vitest";

import { JsonSessionStore } from "~/lib/sessions/json-store";

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describeSessionStore("JsonSessionStore", () => {
  const directory = mkdtempSync(join(tmpdir(), "marbles-session-store-"));
  directories.push(directory);
  return new JsonSessionStore(directory);
});
