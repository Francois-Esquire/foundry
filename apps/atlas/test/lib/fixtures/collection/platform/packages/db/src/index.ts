import { label } from "@k/shared";

export interface Row {
  id: string;
}

export function describeRow(row: Row): string {
  return label(row.id);
}
