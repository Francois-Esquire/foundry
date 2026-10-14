import type { OrderStatus } from "@repo/orders";

import { ORDER_LIMIT } from "@repo/orders/src/model/order";
import { makeTestOrder } from "@repo/orders/testing";

export const status: OrderStatus = "open";
export const limit = ORDER_LIMIT;
export const sample = makeTestOrder();
