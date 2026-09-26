import type { Order, Store } from "@repo/orders";

import { createOrder, OrderParser } from "@repo/orders";

export class MemoryStore implements Store {
  orders: Order[] = [];

  get(id: string): Order | undefined {
    return this.orders.find((order) => order.id === id);
  }
}

export function parseMany(raw: string[]): Order[] {
  const parser = new OrderParser();
  return raw.map((value) => parser.parse(value));
}

export const seeded = [createOrder("a"), createOrder("b"), createOrder("c")];
