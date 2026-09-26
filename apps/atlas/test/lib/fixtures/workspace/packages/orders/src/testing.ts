import type { Order } from "./model/order";

import { createOrder } from "./model/order";

export function makeTestOrder(): Order {
  return createOrder("test");
}
