import { createDatabase, store } from "@inevitable_divu/use-idb";

interface Product {
  id: string;
  name: string;
  priceInCents: number;
  tags: string[];
}

const db = createDatabase({
  name: "use-idb-example-catalog",
  version: 1,
  stores: {
    products: store<Product>()({
      keyPath: "id",
      indexes: {
        by_tag: { keyPath: "tags", multiEntry: true },
      },
    }),
  },
});

export async function findProductsByTag(tag: string): Promise<Product[]> {
  return db.query("products").where("by_tag").equals(tag).toArray();
}

export async function runCatalogExample() {
  await db.putMany("products", [
    {
      id: "keyboard-1",
      name: "Compact keyboard",
      priceInCents: 8999,
      tags: ["office", "wireless"],
    },
    {
      id: "mouse-1",
      name: "Ergonomic mouse",
      priceInCents: 5499,
      tags: ["office", "ergonomic", "wireless"],
    },
    {
      id: "stand-1",
      name: "Laptop stand",
      priceInCents: 3999,
      tags: ["office", "ergonomic"],
    },
  ]);

  const wirelessProducts = await findProductsByTag("wireless");
  const ergonomicCount = await db.query("products").where("by_tag").equals("ergonomic").count();

  return { wirelessProducts, ergonomicCount };
}
