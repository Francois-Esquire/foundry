import { dlopen, FFIType } from "bun:ffi";
import { Console } from "node:console";
import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";

/**
 * Take stdout for the MCP protocol, and send everything else written to it
 * to stderr. Imported source and workflow bodies may print, through Node's
 * `process.stdout`, Bun's own `Bun.stdout`, or a child process that
 * inherits it.
 */

const LIBC: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "libc.dylib",
  linux: "libc.so.6",
};

/**
 * Keep the original stdout on a new descriptor, then point descriptor 1 at
 * stderr, so every writer reaches stderr whatever it bound and whenever it
 * loaded. Undefined where libc cannot be loaded.
 */
function moveDescriptor(): number | undefined {
  const name = LIBC[process.platform];
  if (name === undefined) {
    return;
  }
  let libc: ReturnType<typeof open>;
  try {
    libc = open(name);
  } catch {
    return;
  }
  try {
    const protocol = libc.symbols.dup(1);
    if (protocol < 0) {
      return;
    }
    if (libc.symbols.dup2(2, 1) < 0) {
      throw new Error("could not point stdout at stderr");
    }
    return protocol;
  } finally {
    libc.close();
  }
}

function open(name: string) {
  return dlopen(name, {
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}

/**
 * Bun's `process.stdout` keeps the original stdout once anything touched
 * it, and evlog does when it loads, so it is moved here too: its `write`,
 * the console, and evlog, which binds that `write` when it loads and reads
 * this slot first on every write. Returns the original `write`.
 */
function moveWriters(): Writable["write"] {
  const protocolWrite = process.stdout.write.bind(process.stdout);
  const diagnosticWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = diagnosticWrite;
  Object.assign(globalThis, { __evlogNativeStdoutWrite: diagnosticWrite });
  Object.assign(
    globalThis.console,
    new Console({ stderr: process.stderr, stdout: process.stderr })
  );
  return protocolWrite;
}

/**
 * The stream only the MCP transport writes to. Call once, before anything
 * prints. Without libc, Bun's native stdout and a child that inherits it
 * still reach the protocol stream.
 */
export function takeStdout(): Writable {
  const protocolWrite = moveWriters();
  const protocol = moveDescriptor();
  if (protocol !== undefined) {
    return createWriteStream("", { fd: protocol });
  }
  return new Writable({
    write(chunk, encoding, callback) {
      protocolWrite(chunk, encoding, callback);
    },
  });
}
