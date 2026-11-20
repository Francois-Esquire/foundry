import { readFileSync } from "node:fs";

const WHOLE_PID = /^\d+\s*$/;

export async function pidWritten(path: string): Promise<number> {
  for (let i = 0; i < 500; i += 1) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = "";
    }
    if (WHOLE_PID.test(text)) {
      return Number(text.trim());
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`no pid was written to ${path}`);
}
