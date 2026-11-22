import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function which(
  name: string,
  path: string | undefined = process.env.PATH
): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}
