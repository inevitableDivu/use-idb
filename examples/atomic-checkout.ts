import { createDatabase, store } from "@inevitable_divu/use-idb";

interface InventoryItem {
  id: string;
  name: string;
  remaining: number;
}

interface Order {
  id: string;
  itemId: string;
  quantity: number;
  placedAt: Date;
}

const db = createDatabase({
  name: "use-idb-example-checkout",
  version: 1,
  stores: {
    inventory: store<InventoryItem>()({ keyPath: "id" }),
    orders: store<Order>()({ keyPath: "id" }),
  },
});

export async function placeOrder(itemId: string, quantity: number): Promise<string> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError("Order quantity must be a positive integer.");
  }

  const order: Order = {
    id: crypto.randomUUID(),
    itemId,
    quantity,
    placedAt: new Date(),
  };

  await db.transaction(["inventory", "orders"], "readwrite", async (tx) => {
    const item = await tx.get<InventoryItem>("inventory", itemId);
    if (!item) throw new Error(`Inventory item "${itemId}" does not exist.`);
    if (item.remaining < quantity) throw new Error(`Insufficient stock for "${item.name}".`);

    await tx.put("inventory", { ...item, remaining: item.remaining - quantity });
    await tx.put("orders", order);
  });

  return order.id;
}
