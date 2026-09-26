import type { Repo } from "./repo";

export class MemoryRepo implements Repo {
  private readonly items = new Map<string, string>();
  get(id: string): string | undefined {
    return this.items.get(id);
  }
  put(id: string, value: string): void {
    this.items.set(id, value);
  }
}
