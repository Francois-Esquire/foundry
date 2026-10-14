export interface Foo {
  size: number;
}

export type Mode = "on" | "off";

export function Bar(): number {
  return 1;
}

export function Baz(): number {
  return 2;
}

export class Qux {
  constructor(public readonly value: number) {}
}

export const LIMIT = 3;
