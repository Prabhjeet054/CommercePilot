import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";

function uniqueEmail(): string {
  return `schema-test-${randomUUID()}@example.com`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function createUser() {
  return prisma.user.create({
    data: {
      email: uniqueEmail(),
      passwordHash: "hashed-password-not-plaintext",
      role: "customer",
      name: "Schema Test User",
    },
  });
}

async function createMerchant() {
  return prisma.merchant.create({
    data: { name: `Schema Test Merchant ${randomUUID()}` },
  });
}

async function createProduct(merchantId: string, price: Prisma.Decimal | string = "4499.99") {
  return prisma.product.create({
    data: {
      merchantId,
      name: "Schema Test Product",
      category: "electronics",
      price,
    },
  });
}

async function createPurchaseIntent(userId: string) {
  return prisma.purchaseIntent.create({
    data: {
      userId,
      rawText: "buy running shoes under 5000",
      structuredIntent: { category: "footwear" },
      purchaseMode: "manual",
      status: "CREATED",
    },
  });
}

describe("Prisma schema constraints", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_schema_test_" } } });
    await prisma.payment.deleteMany({ where: { razorpayPaymentId: { startsWith: "pay_schema_test_" } } });
    await prisma.order.deleteMany({ where: { razorpayOrderId: { startsWith: "order_schema_test_" } } });
    await prisma.approval.deleteMany();
    await prisma.policyEvaluation.deleteMany();
    await prisma.agentDecision.deleteMany();
    await prisma.agentRun.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.purchaseIntent.deleteMany({
      where: { rawText: "buy running shoes under 5000" },
    });
    await prisma.productAttribute.deleteMany({
      where: { product: { name: "Schema Test Product" } },
    });
    await prisma.product.deleteMany({ where: { name: "Schema Test Product" } });
    await prisma.financialPolicy.deleteMany();
    await prisma.userPreference.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.user.deleteMany({ where: { email: { startsWith: "schema-test-" } } });
    await prisma.merchant.deleteMany({ where: { name: { startsWith: "Schema Test Merchant " } } });
    await prisma.$disconnect();
  });

  it("connects and can query User", async () => {
    const count = await prisma.user.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("rejects a duplicate User.email", async () => {
    const email = uniqueEmail();
    await prisma.user.create({
      data: { email, passwordHash: "hashed", role: "customer" },
    });

    await expect(
      prisma.user.create({
        data: { email, passwordHash: "hashed", role: "customer" },
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it("rejects a duplicate FinancialPolicy.userId", async () => {
    const user = await createUser();
    const policyData = {
      userId: user.id,
      maxAutonomousAmount: "1000.00",
      dailySpendingLimit: "5000.00",
      approvalThreshold: "2000.00",
      allowedCategories: [] as string[],
      blockedCategories: [] as string[],
    };

    await prisma.financialPolicy.create({ data: policyData });

    await expect(prisma.financialPolicy.create({ data: policyData })).rejects.toSatisfy(
      isUniqueViolation,
    );
  });

  it("stores and reads money as exact Decimal rupees (no float drift)", async () => {
    const merchant = await createMerchant();
    const product = await createProduct(merchant.id, "4499.99");

    expect(product.price).toBeInstanceOf(Prisma.Decimal);
    expect(product.price.toFixed(2)).toBe("4499.99");

    const reread = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(reread.price.toFixed(2)).toBe("4499.99");
  });

  it("rejects a duplicate Order.razorpayOrderId", async () => {
    const user = await createUser();
    const merchant = await createMerchant();
    const product = await createProduct(merchant.id);
    const intentA = await createPurchaseIntent(user.id);
    const intentB = await createPurchaseIntent(user.id);
    const razorpayOrderId = `order_schema_test_${randomUUID()}`;

    await prisma.order.create({
      data: {
        purchaseIntentId: intentA.id,
        productId: product.id,
        razorpayOrderId,
        amount: "4499.99",
        state: "ORDER_CREATED",
      },
    });

    await expect(
      prisma.order.create({
        data: {
          purchaseIntentId: intentB.id,
          productId: product.id,
          razorpayOrderId,
          amount: "4499.99",
          state: "ORDER_CREATED",
        },
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it("rejects a duplicate Payment.razorpayPaymentId", async () => {
    const user = await createUser();
    const merchant = await createMerchant();
    const product = await createProduct(merchant.id);
    const intentA = await createPurchaseIntent(user.id);
    const intentB = await createPurchaseIntent(user.id);

    const orderA = await prisma.order.create({
      data: {
        purchaseIntentId: intentA.id,
        productId: product.id,
        razorpayOrderId: `order_schema_test_${randomUUID()}`,
        amount: "100.00",
        state: "ORDER_CREATED",
      },
    });
    const orderB = await prisma.order.create({
      data: {
        purchaseIntentId: intentB.id,
        productId: product.id,
        razorpayOrderId: `order_schema_test_${randomUUID()}`,
        amount: "100.00",
        state: "ORDER_CREATED",
      },
    });

    const razorpayPaymentId = `pay_schema_test_${randomUUID()}`;

    await prisma.payment.create({
      data: { orderId: orderA.id, razorpayPaymentId, status: "CREATED" },
    });

    await expect(
      prisma.payment.create({
        data: { orderId: orderB.id, razorpayPaymentId, status: "CREATED" },
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it("rejects a duplicate WebhookEvent.eventId", async () => {
    const eventId = `evt_schema_test_${randomUUID()}`;

    await prisma.webhookEvent.create({
      data: {
        eventId,
        eventType: "payment.captured",
        rawPayload: { id: eventId },
        signatureValid: true,
      },
    });

    await expect(
      prisma.webhookEvent.create({
        data: {
          eventId,
          eventType: "payment.captured",
          rawPayload: { id: eventId },
          signatureValid: true,
        },
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it("rejects a duplicate Approval.purchaseIntentId", async () => {
    const user = await createUser();
    const merchant = await createMerchant();
    const product = await createProduct(merchant.id);
    const intent = await createPurchaseIntent(user.id);

    await prisma.approval.create({
      data: {
        purchaseIntentId: intent.id,
        userId: user.id,
        productId: product.id,
        amount: "4499.99",
        status: "PENDING",
      },
    });

    await expect(
      prisma.approval.create({
        data: {
          purchaseIntentId: intent.id,
          userId: user.id,
          productId: product.id,
          amount: "4499.99",
          status: "PENDING",
        },
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it("accepts empty allowedCategories and blockedCategories arrays", async () => {
    const user = await createUser();
    const policy = await prisma.financialPolicy.create({
      data: {
        userId: user.id,
        maxAutonomousAmount: "500.00",
        dailySpendingLimit: "2000.00",
        approvalThreshold: "1000.00",
        allowedCategories: [],
        blockedCategories: [],
      },
    });

    expect(policy.allowedCategories).toEqual([]);
    expect(policy.blockedCategories).toEqual([]);
  });

  it("rejects an illegal PurchaseIntent.status via CHECK constraint", async () => {
    const user = await createUser();

    await expect(
      prisma.purchaseIntent.create({
        data: {
          userId: user.id,
          rawText: "buy running shoes under 5000",
          structuredIntent: {},
          purchaseMode: "manual",
          status: "NOT_A_REAL_STATE",
        },
      }),
    ).rejects.toThrow(/purchase_intents_status_check|check constraint/i);
  });

  it("rejects NULL in a required column (users.password_hash)", async () => {
    const id = randomUUID();
    const email = uniqueEmail();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO users (id, email, password_hash, role) VALUES ('${id}'::uuid, '${email}', NULL, 'customer')`,
      ),
    ).rejects.toThrow(/23502|Failing row contains|Raw query failed/i);
  });

  it("has the required indexes on products, agent_decisions, and audit_logs", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'products_category_idx',
          'products_merchant_id_idx',
          'agent_decisions_agent_run_id_idx',
          'audit_logs_purchase_intent_id_idx',
          'audit_logs_correlation_id_idx'
        )
    `;

    expect(rows.map((row) => row.indexname).sort()).toEqual([
      "agent_decisions_agent_run_id_idx",
      "audit_logs_correlation_id_idx",
      "audit_logs_purchase_intent_id_idx",
      "products_category_idx",
      "products_merchant_id_idx",
    ]);
  });

  it("stores monetary columns as numeric, never float/double/real", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; data_type: string; numeric_scale: number }>
    >`
      SELECT table_name, column_name, data_type, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN (
          'price', 'amount', 'max_autonomous_amount',
          'daily_spending_limit', 'approval_threshold'
        )
      ORDER BY table_name, column_name
    `;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type).toBe("numeric");
      expect(row.numeric_scale).toBe(2);
      expect(["double precision", "real", "money"]).not.toContain(row.data_type);
    }
  });
});
