import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSessionStore } from "@foundry/agents/testing/store";
import { afterAll } from "vitest";

import { JsonSessionStore } from "~/lib/sessions/json-store";

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

// A scope is its own directory; each store asked for is a new instance over
// it, as two processes sharing one directory would be.
describeSessionStore("JsonSessionStore", () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-session-store-"));
  directories.push(root);
  return (scope) => new JsonSessionStore(join(root, scope));
});
