import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { outputLines } from "./helpers/output-lines";

it("collects complete daemon lines across byte boundaries, including UTF-8", () => {
  const output = new PassThrough();
  const lines = outputLines(output);
  const ready = "ready /tmp/marbles.sock";
  const waiting =
    "[workspace] detaching · waiting for engine generation 1 to finish its work";
  const bytes = Buffer.from(`${ready}\n${waiting}\n`);
  for (const byte of bytes) {
    output.write(Buffer.from([byte]));
  }
  output.end();
  expect(lines).toEqual([ready, waiting]);
});
