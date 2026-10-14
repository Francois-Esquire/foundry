import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Copy the fixture's tracked files without local build outputs or agent state. */
export function copyFixture(source: string, destination: string): void {
  const files = execFileSync("git", ["ls-files", "-z", "--", "."], {
    cwd: source,
    encoding: "utf8",
  });
  for (const file of files.split("\0").filter(Boolean)) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source, file), target);
  }
}
