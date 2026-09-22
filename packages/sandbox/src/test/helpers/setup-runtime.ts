import { install } from "microsandbox";

if (!process.env.MSB_HOME) {
  throw new Error("Set MSB_HOME to an isolated integration runtime directory");
}

await install();
