import { readFileSync } from "node:fs";

const WHOLE_PID = /^\d+\s*$/;

/**
 * The pid a process of the test's own writes to `path`, once it is
 * written whole. The file is there before its content (a shell's `>`
 * creates it, then `echo` writes), so its existence proves nothing: the
 * content is what is waited for.
 */
export async function pidWritten(path: string): Promise<number> {
  for (let i = 0; i < 500; i += 1) {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      // Not made yet.
    }
    if (WHOLE_PID.test(text)) {
      return Number(text.trim());
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`no pid was written to ${path}`);
}
