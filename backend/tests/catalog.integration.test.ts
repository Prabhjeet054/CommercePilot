import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import {
  DEMO_LAPTOP_PRICE,
  DEMO_LAPTOP_PRODUCT_ID,
  DEMO_SHOE_PRICE,
  DEMO_SHOE_PRODUCT_ID,
  seedUuid,
} from "../src/modules/catalog/catalog.constants";
import { SEED_MERCHANTS, seedCatalog } from "../prisma/seed";

const JWT_SECRET = "catalog-integration-access";
const JWT_REFRESH_SECRET = "catalog-integration-refresh";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

function uniqueEmail(prefix = "catalog-test"): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

function clientIp(): string {
  return `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const seedMerchantIds = SEED_MERCHANTS.map((merchant) => seedUuid(`merchant:${merchant.key}`));

async function registerUser(role: "customer" | "merchant_admin", name = "Catalog User") {
  const email = uniqueEmail();
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name, role });
  expect(response.status).toBe(201);
  return {
    email,
    token: response.body.accessToken as string,
    user: response.body.user as { id: string; role: string; merchantId: string | null },
  };
}

async function registerMerchantAdmin() {
  const merchant = await prisma.merchant.create({
    data: { name: `catalog-test-m-${randomUUID()}` },
  });
  const admin = await registerUser("merchant_admin", "Catalog Admin");
  await prisma.user.update({
    where: { id: admin.user.id },
    data: { merchantId: merchant.id },
  });
  return { ...admin, merchant };
}

describe("catalog seed and API", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  afterAll(async () => {
    await prisma.productAttribute.deleteMany({
      where: { product: { name: { startsWith: "catalog-test-" } } },
    });
    await prisma.product.deleteMany({ where: { name: { startsWith: "catalog-test-" } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: "catalog-test-" } } });
    await prisma.merchant.deleteMany({ where: { name: { startsWith: "catalog-test-m-" } } });
    await prisma.$disconnect();
  });

  it("is idempotent and contains the two demo-critical products at exact PRD prices", async () => {
    const first = await seedCatalog();
    const productCount = await prisma.product.count({
      where: { merchantId: { in: seedMerchantIds } },
    });
    const merchantCount = await prisma.merchant.count({
      where: { id: { in: seedMerchantIds } },
    });
    const attrCount = await prisma.productAttribute.count({
      where: { product: { merchantId: { in: seedMerchantIds } } },
    });

    const second = await seedCatalog();
    expect(second).toEqual(first);
    expect(await prisma.product.count({ where: { merchantId: { in: seedMerchantIds } } })).toBe(
      productCount,
    );
    expect(await prisma.merchant.count({ where: { id: { in: seedMerchantIds } } })).toBe(
      merchantCount,
    );
    expect(
      await prisma.productAttribute.count({
        where: { product: { merchantId: { in: seedMerchantIds } } },
      }),
    ).toBe(attrCount);

    expect(productCount).toBeGreaterThanOrEqual(40);
    expect(productCount).toBeLessThanOrEqual(60);
    expect(merchantCount).toBeGreaterThanOrEqual(3);
    expect(merchantCount).toBeLessThanOrEqual(5);
    expect(first.byCategory.Sports + first.byCategory.Electronics + first.byCategory.Travel).toBe(
      first.products,
    );

    const shoe = await prisma.product.findUniqueOrThrow({ where: { id: DEMO_SHOE_PRODUCT_ID } });
    const laptop = await prisma.product.findUniqueOrThrow({
      where: { id: DEMO_LAPTOP_PRODUCT_ID },
    });
    expect(shoe.name).toMatch(/running|stride/i);
    expect(shoe.category).toBe("Sports");
    expect(shoe.price.toFixed(2)).toBe(DEMO_SHOE_PRICE);
    expect(laptop.name).toMatch(/laptop|ultrabook/i);
    expect(laptop.category).toBe("Electronics");
    expect(laptop.price.toFixed(2)).toBe(DEMO_LAPTOP_PRICE);
  });

  it("returns the seeded running shoe for Sports under ₹5000", async () => {
    const customer = await registerUser("customer");
    const response = await request(app)
      .get("/products")
      .query({ category: "Sports", maxPrice: "5000" })
      .set(authHeader(customer.token));

    expect(response.status).toBe(200);
    expect(response.body.total).toBeGreaterThan(0);
    const ids = (response.body.products as Array<{ id: string; price: string }>).map(
      (product) => product.id,
    );
    expect(ids).toContain(DEMO_SHOE_PRODUCT_ID);
    expect(ids).not.toContain(DEMO_LAPTOP_PRODUCT_ID);
    for (const product of response.body.products as Array<{ price: string; category: string }>) {
      expect(Number(product.price)).toBeLessThanOrEqual(5000);
      expect(product.category.toLowerCase()).toBe("sports");
    }
  });

  it("combines category, maxPrice, and tags with AND semantics (case-insensitive tags)", async () => {
    const customer = await registerUser("customer");

    const matched = await request(app)
      .get("/products")
      .query({ category: "Sports", maxPrice: "5000", tags: "Cushioning,DISTANCE" })
      .set(authHeader(customer.token));
    expect(matched.status).toBe(200);
    expect(matched.body.products.some((product: { id: string }) => product.id === DEMO_SHOE_PRODUCT_ID)).toBe(
      true,
    );

    const tooCheap = await request(app)
      .get("/products")
      .query({ category: "Sports", maxPrice: "4000", tags: "cushioning" })
      .set(authHeader(customer.token));
    expect(tooCheap.status).toBe(200);
    expect(
      tooCheap.body.products.some((product: { id: string }) => product.id === DEMO_SHOE_PRODUCT_ID),
    ).toBe(false);

    const wrongCategory = await request(app)
      .get("/products")
      .query({ category: "Electronics", maxPrice: "5000", tags: "cushioning" })
      .set(authHeader(customer.token));
    expect(wrongCategory.status).toBe(200);
    expect(wrongCategory.body.products).toEqual([]);
    expect(wrongCategory.body.total).toBe(0);
  });

  it("returns 400 when maxPrice is not a number", async () => {
    const customer = await registerUser("customer");
    const response = await request(app)
      .get("/products")
      .query({ maxPrice: "abc" })
      .set(authHeader(customer.token));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(response.body)).toMatch(/maxPrice must be a number/i);
  });

  it("returns an empty list with 200 when filters match nothing", async () => {
    const customer = await registerUser("customer");
    const response = await request(app)
      .get("/products")
      .query({ category: "Sports", maxPrice: "1" })
      .set(authHeader(customer.token));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ products: [], total: 0 });
  });

  it("returns a zero-stock product on GET (ranking exclusion is later)", async () => {
    const customer = await registerUser("customer");
    const zeroStockId = seedUuid("product:apex-carbon-plate-elite");
    const response = await request(app)
      .get(`/products/${zeroStockId}`)
      .set(authHeader(customer.token));

    expect(response.status).toBe(200);
    expect(response.body.stock).toBe(0);
    expect(response.body.attributes.length).toBeGreaterThan(0);
  });

  it("returns a merchant for display and 404 when missing", async () => {
    const customer = await registerUser("customer");
    const found = await request(app)
      .get(`/merchants/${seedMerchantIds[0]}`)
      .set(authHeader(customer.token));
    expect(found.status).toBe(200);
    expect(found.body.name).toBe("Apex Sports");

    const missing = await request(app)
      .get(`/merchants/${randomUUID()}`)
      .set(authHeader(customer.token));
    expect(missing.status).toBe(404);
  });

  it("lets a merchant_admin create and update their own products", async () => {
    const admin = await registerMerchantAdmin();
    const created = await request(app)
      .post("/products")
      .set(authHeader(admin.token))
      .send({
        name: "catalog-test-own-shoe",
        category: "Sports",
        description: "Owned by admin A",
        price: 1999.5,
        stock: 4,
        tags: ["Trail", "Cushioning"],
        attributes: [{ attrKey: "use", attrValue: "running" }],
      });

    expect(created.status).toBe(201);
    expect(created.body.merchantId).toBe(admin.merchant.id);
    expect(created.body.price).toBe("1999.50");
    expect(created.body.tags).toEqual(["trail", "cushioning"]);
    expect(created.body.stock).toBe(4);

    const updated = await request(app)
      .put(`/products/${created.body.id}`)
      .set(authHeader(admin.token))
      .send({
        name: "catalog-test-own-shoe",
        category: "Sports",
        price: 1899,
        stock: 0,
        tags: ["trail"],
      });
    expect(updated.status).toBe(200);
    expect(updated.body.price).toBe("1899.00");
    expect(updated.body.stock).toBe(0);
  });

  it("rejects customer writes with 403 and foreign merchant edits with 404", async () => {
    const customer = await registerUser("customer");
    const adminA = await registerMerchantAdmin();
    const adminB = await registerMerchantAdmin();

    const denied = await request(app)
      .post("/products")
      .set(authHeader(customer.token))
      .send({ name: "catalog-test-denied", category: "Sports", price: 100, stock: 1 });
    expect(denied.status).toBe(403);

    const product = await request(app)
      .post("/products")
      .set(authHeader(adminA.token))
      .send({ name: "catalog-test-owned-by-a", category: "Sports", price: 500, stock: 2 });
    expect(product.status).toBe(201);

    const foreign = await request(app)
      .put(`/products/${product.body.id}`)
      .set(authHeader(adminB.token))
      .send({ name: "catalog-test-stolen", category: "Sports", price: 500, stock: 2 });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: "NOT_FOUND" });
    expect(foreign.status).not.toBe(403);
  });

  it("rejects negative price and stock with 400", async () => {
    const admin = await registerMerchantAdmin();
    const negativePrice = await request(app)
      .post("/products")
      .set(authHeader(admin.token))
      .send({ name: "catalog-test-neg-price", category: "Sports", price: -1, stock: 1 });
    expect(negativePrice.status).toBe(400);

    const negativeStock = await request(app)
      .post("/products")
      .set(authHeader(admin.token))
      .send({ name: "catalog-test-neg-stock", category: "Sports", price: 10, stock: -4 });
    expect(negativeStock.status).toBe(400);
  });

  it("requires auth on catalog reads", async () => {
    const response = await request(app).get("/products");
    expect(response.status).toBe(401);
  });
});
