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

export function fileMapDisk(prefix: string) {
  const roots: string[] = [];
  return {
    cleanup(): void {
      for (const root of roots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
      }
    },

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
