#!/usr/bin/env bun
import { layout } from "~/layout";
import { startDaemon } from "~/process/daemon";

const daemon = await startDaemon({
  layout: layout(),
  print: (line) => process.stdout.write(`${line}\n`),
});
process.stdout.write(`ready ${String(daemon.pid)}\n`);
await daemon.closed;
