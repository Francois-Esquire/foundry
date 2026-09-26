import type { Scattered } from "@l/core";

export class SqlScattered implements Scattered {
  s = 0;
  read(): number {
    return this.s;
  }
  write(value: number): void {
    this.s = value;
  }
}
