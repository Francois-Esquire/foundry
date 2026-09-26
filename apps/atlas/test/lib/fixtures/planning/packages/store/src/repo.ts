import type { Status } from "@p/core";

export class StoreRepo {
  last?: Status;

  put(s: Status): void {
    this.last = s;
  }
}
