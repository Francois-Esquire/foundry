import type { Status } from "@p/core";

import { formatStatus } from "@p/core";

export function save(s: Status): string {
  return formatStatus(s);
}
