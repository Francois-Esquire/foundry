#!/usr/bin/env bun
import { Engine } from "~/lib/engine";

const { adoptQueued } = Engine.prototype;
Engine.prototype.adoptQueued = function (
  this: Engine,
  ...args: Parameters<Engine["adoptQueued"]>
) {
  process.stderr.write(`take asked for ${args[0]}\n`);
  return adoptQueued.apply(this, args);
} as Engine["adoptQueued"];
await import("~/process/generation");
