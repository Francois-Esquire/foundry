import { sleep, spawn } from "bun";

/** Exercise the packaged renderer in a real PTY without dispatching work. */
export async function inspectDashboard(
  cli: string,
  cwd: string,
  command: readonly string[]
) {
  let output = "";
  const child = spawn([process.execPath, cli, ...command, "--dry"], {
    cwd,
    terminal: {
      cols: 120,
      data(_terminal, bytes) {
        output += Buffer.from(bytes).toString();
      },
      rows: 40,
    },
  });
  async function waitFor(text: string) {
    const deadline = Date.now() + 8000;
    while (!output.includes(text)) {
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(
          `Missing ${text} in terminal output: ${output.slice(-3000)}`
        );
      }
      await sleep(25);
    }
  }
  try {
    await waitFor("Press Enter to enter");
    child.terminal?.write("\r");
    await waitFor("Tab focus");
    await sleep(50);
    child.terminal?.write("q");
    await waitFor("Quit Quirks?");
    child.terminal?.write("\x03");
    const deadline = Date.now() + 8000;
    while (child.exitCode === null) {
      if (Date.now() > deadline) {
        throw new Error("Packaged dashboard did not close");
      }
      await sleep(25);
    }
    return { code: await child.exited, output };
  } finally {
    child.kill();
    await child.exited;
    child.terminal?.close();
  }
}
