import { installRuntime } from "microsandbox";

if (!process.env.MSB_HOME) {
  throw new Error("Set MSB_HOME to an isolated integration runtime directory");
}

await installRuntime({}, { version: "0.7.16" });
