import { randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import {
  DEMO_LAPTOP_PRICE,
  DEMO_LAPTOP_PRODUCT_ID,
  DEMO_SHOE_PRICE,
  DEMO_SHOE_PRODUCT_ID,
  seedUuid,
} from "../src/modules/catalog/catalog.constants";
import { applyOrderLifecycleEvent, createInternalOrder } from "../src/modules/orders/order.service";
import { getMerchantAnalytics } from "../src/modules/analytics/analytics.service";
import { seedCatalog } from "../prisma/seed";

/**
 * Phase 23 validation — multi-tenant isolation is the critical property.
 * Endpoint is strictly self-scoped: GET /analytics/merchant (no merchantId input).
 */

const JWT_SECRET = "analytics-phase23-access!";
const JWT_REFRESH_SECRET = "analytics-phase23-refresh";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

const APEX_MERCHANT_ID = seedUuid("merchant:apex");
const NOVA_MERCHANT_ID = seedUuid("merchant:nova");

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function clientIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
}

async function registerUser(role: "customer" | "merchant_admin", prefix: string) {
  const email = `${prefix}-${randomUUID()}@example.com`;
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Analytics User", role });
  expect(response.status).toBe(201);
  return {
    email,
    token: response.body.accessToken as string,
    userId: response.body.user.id as string,
  };
}

async function loginSeeded(email: string) {
  const response = await request(app)
    .post("/auth/login")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12" });
  expect(response.status).toBe(200);
  return {
    token: response.body.accessToken as string,
    userId: response.body.user.id as string,
    merchantId: response.body.user.merchantId as string | null,
  };
}

async function createMerchantAdmin(namePrefix: string, price = "4499.00") {
  const merchant = await prisma.merchant.create({
    data: { name: `${namePrefix}-m-${randomUUID()}` },
  });
  const product = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      name: `${namePrefix}-product-${randomUUID().slice(0, 8)}`,
      category: "Sports",
      price,
      stock: 10,
    },
  });
  const admin = await registerUser("merchant_admin", "analytics-admin");
  await prisma.user.update({
    where: { id: admin.userId },
    data: { merchantId: merchant.id },
  });
  return { merchant, product, ...admin };
}

async function seedCustomerWithIntent(opts: {
  productId: string;
  status: string;
  reasonCode?: string;
  completeOrder?: boolean;
  amount?: number;
  rawText?: string;
}) {
  const customer = await prisma.user.create({
    data: {
      email: `analytics-cust-${randomUUID()}@example.com`,
      passwordHash: "x".repeat(60),
      role: "customer",
      name: "Analytics Customer",
    },
  });

  const intentStatus =
    opts.completeOrder && opts.status === "COMPLETED" ? "POLICY_ALLOWED" : opts.status;

  const intent = await prisma.purchaseIntent.create({
    data: {
      userId: customer.id,
      rawText: opts.rawText ?? "Analytics fixture purchase intent.",
      structuredIntent: { category: "Sports" },
      purchaseMode: "autonomous",
      status: intentStatus,
      agentRun: {
        create: {
          status: "COMPLETED",
          decisions: {
            create: {
              productId: opts.productId,
              selected: true,
              rank: 1,
            },
          },
        },
      },
      ...(opts.reasonCode
        ? {
            policyEvaluations: {
              create: {
                decision:
                  opts.status === "POLICY_DENIED"
                    ? "DENY"
                    : opts.status === "APPROVAL_REJECTED"
                      ? "REQUIRE_APPROVAL"
                      : "REQUIRE_APPROVAL",
                reasonCode: opts.reasonCode,
                policySnapshot: {},
              },
            },
          }
        : {}),
    },
  });

  let orderId: string | null = null;
  if (opts.completeOrder) {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: opts.productId } });
    const order = await createInternalOrder({
      purchaseIntentId: intent.id,
      productId: opts.productId,
      amount: opts.amount ?? Number(product.price.toString()),
      razorpayOrderId: `order_an_${randomUUID().slice(0, 8)}`,
    });
    await applyOrderLifecycleEvent(order.id, "checkout_opened");
    await applyOrderLifecycleEvent(order.id, "signature_verified");
    await applyOrderLifecycleEvent(order.id, "webhook_captured");
    await applyOrderLifecycleEvent(order.id, "order_paid_confirmed");
    orderId = order.id;
  }

  return { customer, intent, orderId };
}

/** Independent raw SQL — not the analytics service's Prisma path. */
async function sqlCompletedMetrics(merchantId: string): Promise<{ gmv: string; count: number }> {
  const rows = await prisma.$queryRaw<Array<{ gmv: string; cnt: bigint }>>`
    SELECT COALESCE(SUM(o.amount), 0)::text AS gmv, COUNT(*)::bigint AS cnt
    FROM orders o
    INNER JOIN products p ON p.id = o.product_id
    WHERE o.state = 'COMPLETED' AND p.merchant_id = ${merchantId}::uuid
  `;
  const row = rows[0];
  return {
    gmv: Number(row?.gmv ?? 0).toFixed(2),
    count: Number(row?.cnt ?? 0),
  };
}

async function sqlEligibleIntentCount(merchantId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ cnt: bigint }>>`
    SELECT COUNT(DISTINCT ar.purchase_intent_id)::bigint AS cnt
    FROM agent_decisions ad
    INNER JOIN agent_runs ar ON ar.id = ad.agent_run_id
    INNER JOIN products p ON p.id = ad.product_id
    WHERE ad.selected = true AND p.merchant_id = ${merchantId}::uuid
  `;
  return Number(rows[0]?.cnt ?? 0);
}

describe("Phase 23 validation — merchant analytics isolation", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  afterEach(async () => {
    await prisma.payment.deleteMany({
      where: { order: { purchaseIntent: { user: { email: { startsWith: "analytics-cust-" } } } } },
    });
    await prisma.order.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "analytics-cust-" } } } },
    });
    await prisma.policyEvaluation.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "analytics-cust-" } } } },
    });
    await prisma.agentDecision.deleteMany({
      where: { agentRun: { purchaseIntent: { user: { email: { startsWith: "analytics-cust-" } } } } },
    });
    await prisma.agentRun.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "analytics-cust-" } } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "analytics-cust-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "analytics-cust-" } } });

    await prisma.user.updateMany({
      where: { email: { startsWith: "analytics-admin-" } },
      data: { merchantId: null },
    });
    await prisma.product.deleteMany({ where: { name: { startsWith: "analytics-" } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: "analytics-admin-" } } });
    await prisma.merchant.deleteMany({ where: { name: { startsWith: "analytics-" } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("exact GMV/conversion/AOV match hand-calculated values and independent raw SQL", async () => {
    // Hand calc:
    // completed: ₹4,499 + ₹2,000 = ₹6,499 | count 2 | AOV = 6499/2 = 3249.50
    // eligible intents: 2 completed + 1 allowed + 3 flagged = 6 → conversion = 2/6 = 1/3
    const { merchant, product, token } = await createMerchantAdmin("analytics-exact");

    await seedCustomerWithIntent({
      productId: product.id,
      status: "COMPLETED",
      completeOrder: true,
      amount: 4499,
    });
    await seedCustomerWithIntent({
      productId: product.id,
      status: "COMPLETED",
      completeOrder: true,
      amount: 2000,
    });
    await seedCustomerWithIntent({ productId: product.id, status: "POLICY_ALLOWED" });
    await seedCustomerWithIntent({
      productId: product.id,
      status: "POLICY_DENIED",
      reasonCode: "CATEGORY_BLOCKED",
    });
    await seedCustomerWithIntent({
      productId: product.id,
      status: "APPROVAL_REJECTED",
      reasonCode: "AMOUNT_ABOVE_APPROVAL_THRESHOLD",
    });
    await seedCustomerWithIntent({
      productId: product.id,
      status: "PAYMENT_VERIFICATION_FAILED",
      reasonCode: "SIGNATURE_MISMATCH",
    });

    const expectedGmv = "6499.00";
    const expectedCount = 2;
    const expectedEligible = 6;
    const expectedConversion = expectedCount / expectedEligible; // 1/3
    const expectedAov = "3249.50";

    const response = await request(app).get("/analytics/merchant").set(authHeader(token));
    expect(response.status).toBe(200);

    const sql = await sqlCompletedMetrics(merchant.id);
    const sqlEligible = await sqlEligibleIntentCount(merchant.id);
    expect(sql.gmv).toBe(expectedGmv);
    expect(sql.count).toBe(expectedCount);
    expect(sqlEligible).toBe(expectedEligible);

    expect(response.body.gmv).toBe(expectedGmv);
    expect(response.body.gmv).toBe(sql.gmv);
    expect(response.body.completedOrderCount).toBe(expectedCount);
    expect(response.body.eligibleIntentCount).toBe(expectedEligible);
    expect(response.body.conversionRate).toBe(expectedConversion);
    expect(response.body.averageOrderValue).toBe(expectedAov);

    const service = await getMerchantAnalytics(merchant.id);
    expect(service.gmv).toBe(expectedGmv);
    expect(service.conversionRate).toBe(expectedConversion);
    expect(service.averageOrderValue).toBe(expectedAov);
  });

  it("adversarial cross-merchant: query/body/header merchantId cannot divert self-scoped analytics", async () => {
    const a = await createMerchantAdmin("analytics-adv-a");
    const b = await createMerchantAdmin("analytics-adv-b", "120000.00");

    await seedCustomerWithIntent({
      productId: a.product.id,
      status: "COMPLETED",
      completeOrder: true,
      amount: 4499,
    });
    await seedCustomerWithIntent({
      productId: b.product.id,
      status: "COMPLETED",
      completeOrder: true,
      amount: 120000,
    });
    await seedCustomerWithIntent({
      productId: b.product.id,
      status: "APPROVAL_PENDING",
      reasonCode: "AMOUNT_ABOVE_APPROVAL_THRESHOLD",
    });

    const attempts = await Promise.all([
      request(app).get("/analytics/merchant").set(authHeader(a.token)),
      request(app)
        .get(`/analytics/merchant?merchantId=${encodeURIComponent(b.merchant.id)}`)
        .set(authHeader(a.token)),
      request(app)
        .get("/analytics/merchant")
        .query({ merchantId: b.merchant.id, merchant_id: b.merchant.id })
        .set(authHeader(a.token)),
      request(app)
        .get("/analytics/merchant")
        .set(authHeader(a.token))
        .set("X-Merchant-Id", b.merchant.id)
        .send({ merchantId: b.merchant.id }),
    ]);

    for (const response of attempts) {
      expect(response.status).toBe(200);
      expect(response.body.merchantId).toBe(a.merchant.id);
      expect(response.body.gmv).toBe("4499.00");
      expect(response.body.gmv).not.toBe("120000.00");
      expect(
        response.body.flaggedIntents.every(
          (row: { selectedProductId: string | null }) => row.selectedProductId !== b.product.id,
        ),
      ).toBe(true);
      expect(
        response.body.recentCompletedOrders.every(
          (row: { productId: string }) => row.productId === a.product.id,
        ),
      ).toBe(true);
    }

    const bRes = await request(app).get("/analytics/merchant").set(authHeader(b.token));
    expect(bRes.body.merchantId).toBe(b.merchant.id);
    expect(bRes.body.gmv).toBe("120000.00");
  });

  it("merchant_admin with no merchantId → MERCHANT_NOT_ASSOCIATED (safe, no foreign data)", async () => {
    const admin = await registerUser("merchant_admin", "analytics-admin");
    const b = await createMerchantAdmin("analytics-orphan-bait");
    await seedCustomerWithIntent({
      productId: b.product.id,
      status: "COMPLETED",
      completeOrder: true,
      amount: 9999,
    });

    const response = await request(app)
      .get(`/analytics/merchant?merchantId=${b.merchant.id}`)
      .set(authHeader(admin.token));
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("MERCHANT_NOT_ASSOCIATED");
    expect(response.body.gmv).toBeUndefined();
  });

  it("zero-order merchant: clean zeros, no divide-by-zero", async () => {
    const { merchant, token } = await createMerchantAdmin("analytics-empty");
    const response = await request(app).get("/analytics/merchant").set(authHeader(token));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      merchantId: merchant.id,
      gmv: "0.00",
      completedOrderCount: 0,
      eligibleIntentCount: 0,
      conversionRate: 0,
      averageOrderValue: "0.00",
      topProducts: [],
      flaggedIntents: [],
      recentCompletedOrders: [],
    });
  });

  it("flagged feed includes denied/rejected/verification-failed and excludes completed healthy intents", async () => {
    const { product, token } = await createMerchantAdmin("analytics-flags");

    const denied = await seedCustomerWithIntent({
      productId: product.id,
      status: "POLICY_DENIED",
      reasonCode: "CATEGORY_BLOCKED",
    });
    const rejected = await seedCustomerWithIntent({
      productId: product.id,
      status: "APPROVAL_REJECTED",
      reasonCode: "AMOUNT_ABOVE_APPROVAL_THRESHOLD",
    });
    const verifyFailed = await seedCustomerWithIntent({
      productId: product.id,
      status: "PAYMENT_VERIFICATION_FAILED",
    });
    const pending = await seedCustomerWithIntent({
      productId: product.id,
      status: "APPROVAL_PENDING",
      reasonCode: "AMOUNT_ABOVE_APPROVAL_THRESHOLD",
    });
    const completed = await seedCustomerWithIntent({
      productId: product.id,
      status: "COMPLETED",
      completeOrder: true,
      amount: 4499,
    });
    const healthyAllowed = await seedCustomerWithIntent({
      productId: product.id,
      status: "POLICY_ALLOWED",
    });

    const response = await request(app).get("/analytics/merchant").set(authHeader(token));
    expect(response.status).toBe(200);

    const flaggedIds = new Set(
      (response.body.flaggedIntents as Array<{ id: string; status: string }>).map((r) => r.id),
    );
    expect(flaggedIds.has(denied.intent.id)).toBe(true);
    expect(flaggedIds.has(rejected.intent.id)).toBe(true);
    expect(flaggedIds.has(verifyFailed.intent.id)).toBe(true);
    expect(flaggedIds.has(pending.intent.id)).toBe(true);
    expect(flaggedIds.has(completed.intent.id)).toBe(false);
    expect(flaggedIds.has(healthyAllowed.intent.id)).toBe(false);

    const statuses = new Set(
      (response.body.flaggedIntents as Array<{ status: string }>).map((r) => r.status),
    );
    expect(statuses.has("COMPLETED")).toBe(false);
    expect(statuses.has("POLICY_ALLOWED")).toBe(false);
  });

  it("demo script: Scenario 1 shoe COMPLETED + Scenario 2 laptop APPROVAL_PENDING → exact analytics deltas", async () => {
    const apexBefore = await sqlCompletedMetrics(APEX_MERCHANT_ID);
    const novaBefore = await sqlCompletedMetrics(NOVA_MERCHANT_ID);
    const novaFlaggedBefore = (
      await getMerchantAnalytics(NOVA_MERCHANT_ID)
    ).flaggedIntents.filter((row) => row.selectedProductId === DEMO_LAPTOP_PRODUCT_ID).length;

    // Scenario 1 — shoe completion (Apex)
    await seedCustomerWithIntent({
      productId: DEMO_SHOE_PRODUCT_ID,
      status: "COMPLETED",
      completeOrder: true,
      amount: Number(DEMO_SHOE_PRICE),
      rawText:
        "I need running shoes under ₹5,000. I run around 25 km every week. Buy the best option automatically.",
    });
    // Scenario 2 — laptop approval-pending (Nova)
    await seedCustomerWithIntent({
      productId: DEMO_LAPTOP_PRODUCT_ID,
      status: "APPROVAL_PENDING",
      reasonCode: "AMOUNT_ABOVE_APPROVAL_THRESHOLD",
      rawText: `Buy the Nova Ultrabook around ₹${DEMO_LAPTOP_PRICE}.`,
    });

    const apex = await loginSeeded("arjun@apex.commercepilot.demo");
    const nova = await loginSeeded("neha@nova.commercepilot.demo");
    expect(apex.merchantId).toBe(APEX_MERCHANT_ID);
    expect(nova.merchantId).toBe(NOVA_MERCHANT_ID);

    const apexRes = await request(app).get("/analytics/merchant").set(authHeader(apex.token));
    const novaRes = await request(app).get("/analytics/merchant").set(authHeader(nova.token));
    expect(apexRes.status).toBe(200);
    expect(novaRes.status).toBe(200);

    const apexSql = await sqlCompletedMetrics(APEX_MERCHANT_ID);
    const novaSql = await sqlCompletedMetrics(NOVA_MERCHANT_ID);

    // Exact match vs independent SQL (authoritative), and exact demo deltas.
    expect(apexRes.body.gmv).toBe(apexSql.gmv);
    expect(apexRes.body.completedOrderCount).toBe(apexSql.count);
    expect(Number(apexSql.gmv) - Number(apexBefore.gmv)).toBe(Number(DEMO_SHOE_PRICE));
    expect(apexSql.count - apexBefore.count).toBe(1);

    expect(novaRes.body.gmv).toBe(novaSql.gmv);
    expect(novaSql.count - novaBefore.count).toBe(0);

    expect(
      apexRes.body.recentCompletedOrders.some(
        (row: { productId: string; amount: string }) =>
          row.productId === DEMO_SHOE_PRODUCT_ID && row.amount === DEMO_SHOE_PRICE,
      ),
    ).toBe(true);

    const novaLaptopFlags = (
      novaRes.body.flaggedIntents as Array<{
        status: string;
        selectedProductId: string | null;
        reasonCode: string | null;
      }>
    ).filter((row) => row.selectedProductId === DEMO_LAPTOP_PRODUCT_ID);
    expect(novaLaptopFlags.length).toBe(novaFlaggedBefore + 1);
    expect(
      novaLaptopFlags.some(
        (row) =>
          row.status === "APPROVAL_PENDING" &&
          row.reasonCode === "AMOUNT_ABOVE_APPROVAL_THRESHOLD",
      ),
    ).toBe(true);

    // Apex must not absorb Nova laptop GMV or laptop flagged rows.
    expect(Number(apexRes.body.gmv)).toBeLessThan(Number(DEMO_LAPTOP_PRICE));
    expect(
      (apexRes.body.flaggedIntents as Array<{ selectedProductId: string | null }>).every(
        (row) => row.selectedProductId !== DEMO_LAPTOP_PRODUCT_ID,
      ),
    ).toBe(true);
  });

  it("returns 401/403 for unauthenticated and customer roles", async () => {
    expect((await request(app).get("/analytics/merchant")).status).toBe(401);
    const customer = await registerUser("customer", "analytics-admin");
    expect(
      (await request(app).get("/analytics/merchant").set(authHeader(customer.token))).status,
    ).toBe(403);
  });
});
