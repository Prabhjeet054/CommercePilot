import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPurchaseIntentEvent, IllegalTransitionError } from "../src/lib/state-machine";
import { prisma } from "../src/lib/prisma";
import { DEMO_SHOE_PRICE, DEMO_SHOE_PRODUCT_ID } from "../src/modules/catalog/catalog.constants";
import { createInternalOrder } from "../src/modules/orders/order.service";
import { seedCatalog } from "../prisma/seed";

function uniqueEmail(): string {
  return `order-service-${randomUUID()}@example.com`;
}

async function createUser() {
  return prisma.user.create({
    data: {
      email: uniqueEmail(),
      passwordHash: "hashed-password-not-plaintext",
      role: "customer",
      name: "Order Service User",
    },
  });
}

async function createIntent(userId: string, status: string) {
  return prisma.purchaseIntent.create({
    data: {
      userId,
      rawText: "buy running shoes under 5000",
      structuredIntent: { category: "Sports" },
      purchaseMode: "autonomous",
      status,
    },
  });
}

describe("createInternalOrder", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  it("creates an Order in ORDER_CREATED with no razorpayOrderId from POLICY_ALLOWED", async () => {
    const user = await createUser();
    const intent = await createIntent(user.id, "POLICY_ALLOWED");

    const order = await createInternalOrder({
      purchaseIntentId: intent.id,
      productId: DEMO_SHOE_PRODUCT_ID,
      amount: Number(DEMO_SHOE_PRICE),
    });

    expect(order.state).toBe("ORDER_CREATED");
    expect(order.razorpayOrderId).toBeNull();
    expect(order.amount).toBe(DEMO_SHOE_PRICE);
    expect(order.currency).toBe("INR");
    expect(order.productId).toBe(DEMO_SHOE_PRODUCT_ID);

    const storedIntent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(storedIntent.status).toBe("ORDER_CREATED");

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.razorpayOrderId).toBeNull();
    expect(row.state).toBe("ORDER_CREATED");
  });

  it("creates an Order from APPROVED the same way", async () => {
    const user = await createUser();
    const intent = await createIntent(user.id, "APPROVED");

    const order = await createInternalOrder({
      purchaseIntentId: intent.id,
      productId: DEMO_SHOE_PRODUCT_ID,
      amount: Number(DEMO_SHOE_PRICE),
    });

    expect(order.state).toBe("ORDER_CREATED");
    const storedIntent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(storedIntent.status).toBe("ORDER_CREATED");
  });

  it("refuses to create an order from POLICY_DENIED", async () => {
    const user = await createUser();
    const intent = await createIntent(user.id, "POLICY_DENIED");

    await expect(
      createInternalOrder({
        purchaseIntentId: intent.id,
        productId: DEMO_SHOE_PRODUCT_ID,
        amount: Number(DEMO_SHOE_PRICE),
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    expect(await prisma.order.count({ where: { purchaseIntentId: intent.id } })).toBe(0);
    const storedIntent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(storedIntent.status).toBe("POLICY_DENIED");
  });

  it("refuses a second order_created (idempotent retry of a state-changing event is an error)", async () => {
    const user = await createUser();
    const intent = await createIntent(user.id, "POLICY_ALLOWED");

    await createInternalOrder({
      purchaseIntentId: intent.id,
      productId: DEMO_SHOE_PRODUCT_ID,
      amount: Number(DEMO_SHOE_PRICE),
    });

    await expect(
      createInternalOrder({
        purchaseIntentId: intent.id,
        productId: DEMO_SHOE_PRODUCT_ID,
        amount: Number(DEMO_SHOE_PRICE),
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    expect(await prisma.order.count({ where: { purchaseIntentId: intent.id } })).toBe(1);
  });
});

describe("applyPurchaseIntentEvent adversarial and retry", () => {
  it("rejects POLICY_DENIED → COMPLETED via the persist wrapper and does not change the row", async () => {
    const user = await createUser();
    const intent = await createIntent(user.id, "POLICY_DENIED");

    await expect(applyPurchaseIntentEvent(intent.id, "order_paid_confirmed")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await expect(applyPurchaseIntentEvent(intent.id, "webhook_captured")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await expect(applyPurchaseIntentEvent(intent.id, "order_created")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );

    const stored = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(stored.status).toBe("POLICY_DENIED");
    expect(await prisma.order.count({ where: { purchaseIntentId: intent.id } })).toBe(0);
  });

  it("a repeated state-changing event errors and leaves the persisted status unchanged", async () => {
    const user = await createUser();
    const intent = await createIntent(user.id, "CREATED");

    await expect(applyPurchaseIntentEvent(intent.id, "intent_extracted")).resolves.toBe("INTENT_EXTRACTED");
    await expect(applyPurchaseIntentEvent(intent.id, "intent_extracted")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );

    const stored = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(stored.status).toBe("INTENT_EXTRACTED");
  });
});

afterAll(async () => {
  await prisma.order.deleteMany({
    where: { purchaseIntent: { user: { email: { startsWith: "order-service-" } } } },
  });
  await prisma.purchaseIntent.deleteMany({
    where: { user: { email: { startsWith: "order-service-" } } },
  });
  await prisma.user.deleteMany({ where: { email: { startsWith: "order-service-" } } });
});
