import type { Scattered } from "./scattered";

export class MemoryScattered implements Scattered {
  s = 0;
  read(): number {
    return this.s;
  }
  write(value: number): void {
    this.s = value;
  }
}
