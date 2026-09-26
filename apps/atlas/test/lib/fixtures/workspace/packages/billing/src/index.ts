import type { Order } from "@repo/orders";

import { createOrder } from "@repo/orders";

export function bill(order: Order): Order {
  return createOrder(order.id);
}
