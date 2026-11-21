import { chmodSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export function homedCli(bin: string, variable: string, home: string): string {
  const path = `${bin}-${basename(home)}`;
  writeFileSync(
    path,
    `#!/bin/sh\n${variable}=${JSON.stringify(home)} exec ${JSON.stringify(bin)} "$@"\n`
  );
  chmodSync(path, 0o755);
  return path;
}
