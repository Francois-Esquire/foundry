#!/usr/bin/env bun
import { layout } from "~/layout";
import { startDaemon } from "~/process/daemon";
import { envFilesLoaded } from "~/process/runtime";

const refusal = envFilesLoaded();
if (refusal === undefined) {
  const daemon = await startDaemon({
    layout: layout(),
    print: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
  let finish: () => void = () => undefined;
  const done = new Promise<void>((settle) => {
    finish = settle;
  });
  const stop = () => finish();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await Promise.race([done, daemon.closed]);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await daemon.close();
  }
} else {
  process.stderr.write(`marbles: ${refusal}\n`);
  process.exitCode = 1;
}
