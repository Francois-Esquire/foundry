#!/usr/bin/env bun
import { Engine } from "~/lib/engine";

const { takeQueued } = Engine.prototype;
Engine.prototype.takeQueued = function (
  this: Engine,
  ...args: Parameters<Engine["takeQueued"]>
) {
  process.stderr.write(`take asked for ${args[0]}\n`);
  return takeQueued.apply(this, args);
} as Engine["takeQueued"];
await import("~/process/generation");
