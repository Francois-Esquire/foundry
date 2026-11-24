import type { StepSpec } from "../../step";

export function makeEchoSpec<T>(input: T, name = "echo"): StepSpec<T, T> {
  return {
    execute: async (i) => i,
    input,
    name,
  };
}
