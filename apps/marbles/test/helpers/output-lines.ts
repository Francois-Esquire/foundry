import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export function outputLines(output: Readable): readonly string[] {
  const lines: string[] = [];
  createInterface({ input: output }).on("line", (line) => lines.push(line));
  return lines;
}
