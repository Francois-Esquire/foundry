import type { Domain } from "@l/core";

export interface StoredDomain {
  id: string;
  status: string;
  attempts: number;
  output: string;
  storedAt: number;
}

export function toStored(domain: Domain): StoredDomain {
  return { ...domain, storedAt: 0 };
}

export function fromStored(stored: StoredDomain): Domain {
  const { storedAt: _storedAt, ...domain } = stored;
  return domain;
}
