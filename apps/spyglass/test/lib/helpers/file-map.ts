import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

// Recorded repository file maps for tests: a directory read as one, and a
// map written onto disk so native discovery and analysis read the same bytes.

/** Every file below `dir` as repository-relative POSIX path to text. */
export function recordFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
      } else {
        files[relative(dir, absolute).split("\\").join("/")] = readFileSync(
          absolute,
          "utf8"
        );
      }
    }
  };
  walk(dir);
  return files;
}

/** Writes maps below fresh temporary directories and removes them all on `cleanup`. */
export function fileMapDisk(prefix: string) {
  const roots: string[] = [];
  return {
    cleanup(): void {
      for (const root of roots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
      }
    },
    /** The map's files on disk, at a fresh real path. */
    materialize(files: Readonly<Record<string, string>>): string {
      const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      roots.push(root);
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
      }
      return root;
    },
  };
}
