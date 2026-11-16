#!/usr/bin/env bun
import { layout } from "~/layout";
import { startDaemon } from "~/process/daemon";

/**
 * A Marbles process of its own, for a test that must end it the way a
 * crash would, its generations left running: it says each line it prints,
 * and `ready <pid>` once it listens.
 */
const daemon = await startDaemon({
  layout: layout(),
  print: (line) => process.stdout.write(`${line}\n`),
});
process.stdout.write(`ready ${String(daemon.pid)}\n`);
await daemon.closed;
