import type { Status } from "@p/core";
import type { Token } from "@p/store";

import { formatStatus, Widget } from "@p/core";
import { save } from "@p/store";

export function main(t: Token): string {
  const s: Status = { ok: t.id.length > 0 };
  const w = new Widget(2, { min: 0, max: 10 });
  return `${formatStatus(s)} ${save(s)} ${w.area()}`;
}
