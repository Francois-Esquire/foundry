import { helperOnly } from "@p/core";

export function useHelper(): number {
  return helperOnly() + 1;
}
