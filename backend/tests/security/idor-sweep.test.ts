import { randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { setLLMProviderForTests } from "../../src/lib/get-llm-provider";
import { MockLLMProvider } from "../../src/lib/providers/mock-provider";
import { prisma } from "../../src/lib/prisma";
import { DEMO_SHOE_PRODUCT_ID, seedUuid } from "../../src/modules/catalog/catalog.constants";
import { buildIntentPrompt, DEMO_INTENT_PHRASE } from "../../src/modules/intent/intent-agent";
import type { LlmIntent } from "../../src/modules/intent/intent.schema";
import {
  setRazorpayClientForTests,
  type RazorpayOrdersClient,
} from "../../src/modules/payments/razorpay-client";
import { seedCatalog } from "../../prisma/seed";

/**
 * PRD §22 AuthZ / IDOR sweep — cross-user and cross-merchant access must 404 (or 403 for role),
 * never leak another tenant's resource.
 */

const JWT_SECRET = "security-idor-access-secret!!";
const JWT_REFRESH_SECRET = "security-idor-refresh-secret";
process.env.PURCHASE_INTENT_RATE_LIMIT_MAX = "100";
process.env.RAZORPAY_KEY_ID = "rzp_test_idor";
process.env.RAZORPAY_KEY_SECRET = "idor-key-secret";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

const shoeLlm: LlmIntent = {
  category: "running_shoes",
  budget: 5000,
  currency: "INR",
  purpose: "running shoes",
  usage: "25 km",
  priority: "best",
  purchaseMode: "autonomous",
  hasAdditionalUnparsedRequest: false,
};

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function clientIp() {
  return `203.0.113.${1 + Math.floor(Math.random() * 200)}`;
}

async function register(role: "customer" | "merchant_admin", prefix: string) {
  const email = `${prefix}-${randomUUID()}@example.com`;
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "IDOR User", role });
  expect(response.status).toBe(201);
  return {
    email,
    token: response.body.accessToken as string,
    userId: response.body.user.id as string,
  };
}

describe("security: IDOR sweep", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  beforeEach(() => {
    setLLMProviderForTests(
      new MockLLMProvider({
        fixtures: { [buildIntentPrompt(DEMO_INTENT_PHRASE)]: shoeLlm },
      }),
    );
    setRazorpayClientForTests({
      async createOrder(input) {
        return { id: `order_idor_${randomUUID().slice(0, 8)}`, amount: input.amount, currency: input.currency };
      },
      async fetchOrder(id) {
        return { id, status: "created" };
      },
      async fetchOrderPayments() {
        return [];
      },
    } satisfies RazorpayOrdersClient);
  });

  afterEach(async () => {
    setLLMProviderForTests(null);
    setRazorpayClientForTests(null);
    await prisma.payment.deleteMany({
      where: { order: { purchaseIntent: { user: { email: { startsWith: "sec-idor-" } } } } },
    });
    await prisma.order.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "sec-idor-" } } } },
    });
    await prisma.approval.deleteMany({
      where: { user: { email: { startsWith: "sec-idor-" } } },
    });
    await prisma.auditLog.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "sec-idor-" } } } },
    });
    await prisma.policyEvaluation.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "sec-idor-" } } } },
    });
    await prisma.agentDecision.deleteMany({
      where: { agentRun: { purchaseIntent: { user: { email: { startsWith: "sec-idor-" } } } } },
    });
    await prisma.agentRun.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "sec-idor-" } } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "sec-idor-" } } },
    });
    await prisma.financialPolicy.deleteMany({
      where: { user: { email: { startsWith: "sec-idor-" } } },
    });
    await prisma.user.updateMany({
      where: { email: { startsWith: "sec-idor-admin-" } },
      data: { merchantId: null },
    });
    await prisma.product.deleteMany({ where: { name: { startsWith: "sec-idor-product-" } } });
    await prisma.user.deleteMany({
      where: { email: { startsWith: "sec-idor-" } },
    });
    await prisma.merchant.deleteMany({ where: { name: { startsWith: "sec-idor-m-" } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("customer cannot read another customer's purchase intent, timeline, or explain", async () => {
    const owner = await register("customer", "sec-idor-owner");
    const stranger = await register("customer", "sec-idor-stranger");

    await request(app)
      .post("/policies")
      .set(authHeader(owner.token))
      .send({
        maxAutonomousAmount: 5000,
        dailySpendingLimit: 10000,
        approvalThreshold: 5000,
        allowedCategories: ["Electronics", "Sports", "Travel"],
        blockedCategories: [],
        trustedMerchants: [],
        autonomousEnabled: true,
        maxAutonomousTxnsPerDay: 20,
      });

    const created = await request(app)
      .post("/purchase-intents")
      .set(authHeader(owner.token))
      .set("X-Forwarded-For", clientIp())
      .send({ text: DEMO_INTENT_PHRASE, purchaseMode: "autonomous" });
    expect(created.status).toBe(201);
    const intentId = created.body.id as string;

    const getIntent = await request(app)
      .get(`/purchase-intents/${intentId}`)
      .set(authHeader(stranger.token));
    expect(getIntent.status).toBe(404);

    const timeline = await request(app)
      .get(`/agent/decisions/${intentId}/timeline`)
      .set(authHeader(stranger.token));
    expect(timeline.status).toBe(404);

    const explain = await request(app)
      .get(`/agent/decisions/${intentId}/explain`)
      .set(authHeader(stranger.token));
    expect(explain.status).toBe(404);
    expect(explain.body.error).toBe("NOT_FOUND");
  });

  it("customer cannot create-order or retry another customer's order", async () => {
    const owner = await register("customer", "sec-idor-pay-owner");
    const stranger = await register("customer", "sec-idor-pay-stranger");
    const intent = await prisma.purchaseIntent.create({
      data: {
        userId: owner.userId,
        rawText: "shoes",
        structuredIntent: {},
        purchaseMode: "autonomous",
        status: "POLICY_ALLOWED",
        agentRun: {
          create: {
            status: "COMPLETED",
            decisions: {
              create: { productId: DEMO_SHOE_PRODUCT_ID, selected: true, rank: 1 },
            },
          },
        },
      },
    });

    const create = await request(app)
      .post("/payments/create-order")
      .set(authHeader(stranger.token))
      .send({ purchaseIntentId: intent.id });
    expect(create.status).toBe(404);

    const owned = await request(app)
      .post("/payments/create-order")
      .set(authHeader(owner.token))
      .send({ purchaseIntentId: intent.id });
    expect(owned.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { purchaseIntentId: intent.id } });
    const retry = await request(app)
      .post(`/payments/${order.id}/retry`)
      .set(authHeader(stranger.token));
    expect(retry.status).toBe(404);
  });

  it("merchant A cannot read merchant B analytics or update B's product", async () => {
    const merchantB = await prisma.merchant.create({
      data: { name: `sec-idor-m-${randomUUID()}` },
    });
    const productB = await prisma.product.create({
      data: {
        merchantId: merchantB.id,
        name: `sec-idor-product-${randomUUID().slice(0, 6)}`,
        category: "Sports",
        price: "1000.00",
        stock: 1,
      },
    });

    const adminA = await register("merchant_admin", "sec-idor-admin-a");
    const adminB = await register("merchant_admin", "sec-idor-admin-b");
    const merchantA = await prisma.merchant.create({
      data: { name: `sec-idor-m-${randomUUID()}` },
    });
    await prisma.user.update({ where: { id: adminA.userId }, data: { merchantId: merchantA.id } });
    await prisma.user.update({ where: { id: adminB.userId }, data: { merchantId: merchantB.id } });

    const analyticsA = await request(app)
      .get(`/analytics/merchant?merchantId=${merchantB.id}`)
      .set(authHeader(adminA.token));
    expect(analyticsA.status).toBe(200);
    expect(analyticsA.body.merchantId).toBe(merchantA.id);
    expect(analyticsA.body.merchantId).not.toBe(merchantB.id);

    const update = await request(app)
      .put(`/products/${productB.id}`)
      .set(authHeader(adminA.token))
      .send({
        name: "Hijacked",
        category: "Sports",
        price: 1,
        stock: 1,
      });
    expect(update.status).toBe(404);
  });

  it("seeded Apex admin analytics stay off Nova merchantId even with query tampering", async () => {
    const apex = await request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", clientIp())
      .send({ email: "arjun@apex.commercepilot.demo", password: "password12" });
    expect(apex.status).toBe(200);

    const novaId = seedUuid("merchant:nova");
    const response = await request(app)
      .get(`/analytics/merchant?merchantId=${novaId}`)
      .set(authHeader(apex.body.accessToken));
    expect(response.status).toBe(200);
    expect(response.body.merchantId).toBe(seedUuid("merchant:apex"));
  });
});
