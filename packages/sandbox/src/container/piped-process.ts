import { once } from "node:events";
import { constants } from "node:os";
import { Writable } from "node:stream";
import type { ExecHandle, ExecSink } from "microsandbox";
import { ProcessController, processError } from "../process-controller";
import type { SandboxPipedProcess } from "../types";

/** The native protocol stays byte-oriented all the way to the host consumer. */
export async function pipedProcess(
  handle: ExecHandle,
  signal?: AbortSignal
): Promise<SandboxPipedProcess> {
  let sink: ExecSink | null;
  try {
    sink = await handle.takeStdin();
    signal?.throwIfAborted();
    if (!sink) {
      throw new Error("Piped process did not provide stdin");
    }
  } catch (error) {
    await handle.kill();
    await handle[Symbol.asyncDispose]();
    throw error;
  }
  const process = new ProcessController(async (value) => {
    const number =
      typeof value === "number"
        ? value
        : constants.signals[value as NodeJS.Signals];
    if (number === undefined) {
      throw new Error(`Unknown process signal: ${value}`);
    }
    await handle.signal(number);
  });
  const input = inputStream(sink);
  input.on("error", (error: Error) => process.fail(error));
  process.stdin.pipe(input);
  process.stdin.once("close", () => input.end());
  const abort = () => {
    process.kill("SIGKILL");
    process.fail(processError(signal?.reason ?? "Process aborted"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  const drain = async () => {
    try {
      const exitCode = await forwardOutput(handle, process, signal);
      signal?.throwIfAborted();
      await sink.close();
      process.complete(exitCode);
    } catch (error) {
      process.fail(processError(error));
      await handle.kill();
    } finally {
      signal?.removeEventListener("abort", abort);
      input.destroy();
      await handle[Symbol.asyncDispose]();
    }
  };
  drain().catch((error: unknown) => process.fail(processError(error)));
  return process;
}

async function forwardOutput(
  handle: ExecHandle,
  process: ProcessController,
  signal?: AbortSignal
): Promise<number> {
  let exitCode: number | undefined;
  for await (const event of handle) {
    // SDK 0.6.18 emits undefined for a failed guest spawn despite its declaration.
    if (event === undefined) {
      await handle.wait();
      throw new Error("MicroSandbox returned an invalid exec event");
    }
    if (event.kind === "stdout" || event.kind === "stderr") {
      const output = event.kind === "stdout" ? process.stdout : process.stderr;
      if (!output.write(event.data)) {
        await once(output, "drain", { signal });
      }
    } else if (event.kind === "exited") {
      exitCode = event.code;
    }
  }
  return exitCode ?? (await handle.wait()).code;
}

function inputStream(sink: ExecSink): Writable {
  return new Writable({
    final(done) {
      sink.close().then(
        () => done(),
        (error: unknown) => done(processError(error))
      );
    },
    write(chunk: Buffer, _encoding, done) {
      sink.write(chunk).then(
        () => done(),
        (error: unknown) => done(processError(error))
      );
    },
  });
}
