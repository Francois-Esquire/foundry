export interface Order {
  id: string;
  total: number;
}

export interface Store {
  get(id: string): Order | undefined;
}

export type OrderStatus = "open" | "closed";

export function createOrder(id: string): Order {
  return { id, total: 0 };
}

export function normalizeOrder(order: Order): Order {
  return helper(order);
}

export class OrderParser {
  parse(raw: string): Order {
    return createOrder(raw);
  }
}

export const ORDER_LIMIT = 10;

function helper(order: Order): Order {
  return order;
}
