import type { Repo } from "@l/core";

export class SqlRepo implements Repo {
  private readonly rows: Record<string, string> = {};
  get(id: string): string | undefined {
    return this.rows[id];
  }
  put(id: string, value: string): void {
    this.rows[id] = value;
  }
}
