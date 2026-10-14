import { spawn } from "bun";

export async function openBrowser(url: string): Promise<void> {
  const commands: Record<string, string[]> = {
    darwin: ["open", url],
    linux: ["xdg-open", url],
    win32: ["rundll32.exe", "url.dll,FileProtocolHandler", url],
  };
  const command = commands[process.platform];
  if (!command) {
    throw new Error(
      "Automatic browser opening is unavailable on this platform."
    );
  }
  const child = spawn(command, { stderr: "ignore", stdout: "ignore" });
  if ((await child.exited) !== 0) {
    throw new Error("The browser could not be opened automatically.");
  }
}
