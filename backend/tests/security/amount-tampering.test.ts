import { createHmac, randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { DEMO_SHOE_PRICE, DEMO_SHOE_PRODUCT_ID } from "../../src/modules/catalog/catalog.constants";
import { amountInPaise } from "../../src/modules/payments/create-order";
import {
  setRazorpayClientForTests,
  type RazorpayOrderCreateInput,
  type RazorpayOrdersClient,
} from "../../src/modules/payments/razorpay-client";
import { createOrderBodySchema, verifyPaymentBodySchema } from "../../src/modules/payments/payments.schema";
import { seedCatalog } from "../../prisma/seed";

/**
 * PRD §22/23 — Amount tampering: client cannot complete payment for anything other than
 * the server-determined Order.amount (catalog price).
 */

const JWT_SECRET = "security-amount-access-secret!";
const JWT_REFRESH_SECRET = "security-amount-refresh-secret";
const RAZORPAY_SECRET = "security-amount-rzp-secret";

process.env.RAZORPAY_KEY_ID = "rzp_test_security_amount";
process.env.RAZORPAY_KEY_SECRET = RAZORPAY_SECRET;
process.env.PURCHASE_INTENT_RATE_LIMIT_MAX = "100";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

class RecordingClient implements RazorpayOrdersClient {
  readonly calls: RazorpayOrderCreateInput[] = [];
  nextId = `order_sec_${randomUUID().slice(0, 8)}`;

  async createOrder(input: RazorpayOrderCreateInput) {
    this.calls.push(input);
    return { id: this.nextId, amount: input.amount, currency: input.currency };
  }
  async fetchOrder(id: string) {
    return { id, status: "created" };
  }
  async fetchOrderPayments() {
    return [];
  }
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function clientIp() {
  return `203.0.113.${1 + Math.floor(Math.random() * 200)}`;
}

async function registerCustomer() {
  const email = `sec-amt-${randomUUID()}@example.com`;
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Amount User", role: "customer" });
  expect(response.status).toBe(201);
  return { token: response.body.accessToken as string, userId: response.body.user.id as string, email };
}

async function createPayableIntent(userId: string) {
  return prisma.purchaseIntent.create({
    data: {
      userId,
      rawText: "shoes",
      structuredIntent: { category: "Sports" },
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
}

describe("security: amount tampering end-to-end", () => {
  let razorpay: RecordingClient;

  beforeAll(async () => {
    await seedCatalog();
  });

  beforeEach(() => {
    razorpay = new RecordingClient();
    setRazorpayClientForTests(razorpay);
  });

  afterEach(async () => {
    setRazorpayClientForTests(null);
    await prisma.payment.deleteMany({
      where: { order: { purchaseIntent: { user: { email: { startsWith: "sec-amt-" } } } } },
    });
    await prisma.order.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "sec-amt-" } } } },
    });
    await prisma.agentDecision.deleteMany({
      where: { agentRun: { purchaseIntent: { user: { email: { startsWith: "sec-amt-" } } } } },
    });
    await prisma.agentRun.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "sec-amt-" } } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "sec-amt-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "sec-amt-" } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("create-order schema strips client-supplied amount; Razorpay amount equals catalog paise only", async () => {
    const customer = await registerCustomer();
    const intent = await createPayableIntent(customer.userId);
    const expectedPaise = amountInPaise(DEMO_SHOE_PRICE);

    const parsed = createOrderBodySchema.safeParse({
      purchaseIntentId: intent.id,
      amount: 1,
      amountInPaise: 100,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "amount" in parsed.data).toBe(false);

    const response = await request(app)
      .post("/payments/create-order")
      .set(authHeader(customer.token))
      .send({
        purchaseIntentId: intent.id,
        amount: 1,
        amountInPaise: 100,
        currency: "USD",
      });

    expect(response.status).toBe(200);
    expect(response.body.amount).toBe(expectedPaise);
    expect(razorpay.calls).toHaveLength(1);
    expect(razorpay.calls[0]?.amount).toBe(expectedPaise);

    const order = await prisma.order.findUniqueOrThrow({ where: { purchaseIntentId: intent.id } });
    expect(order.amount.toFixed(2)).toBe(DEMO_SHOE_PRICE);
  });

  it("verify schema rejects/strips amount fields; signature path never takes client amount", async () => {
    const customer = await registerCustomer();
    const intent = await createPayableIntent(customer.userId);
    const created = await request(app)
      .post("/payments/create-order")
      .set(authHeader(customer.token))
      .send({ purchaseIntentId: intent.id });
    expect(created.status).toBe(200);

    const paymentId = `pay_${randomUUID().slice(0, 8)}`;
    const signature = createHmac("sha256", RAZORPAY_SECRET)
      .update(`${created.body.razorpayOrderId}|${paymentId}`)
      .digest("hex");

    const stripped = verifyPaymentBodySchema.safeParse({
      razorpay_order_id: created.body.razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
      amount: 1,
      amountInPaise: 100,
    });
    expect(stripped.success).toBe(true);
    expect(stripped.success && "amount" in stripped.data).toBe(false);

    const verified = await request(app)
      .post("/payments/verify")
      .set(authHeader(customer.token))
      .send({
        razorpay_order_id: created.body.razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
        amount: 1,
      });
    expect(verified.status).toBe(200);
    expect(verified.body.verified).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { purchaseIntentId: intent.id } });
    expect(order.amount.toFixed(2)).toBe(DEMO_SHOE_PRICE);
    expect(order.state).toBe("PAYMENT_AUTHORIZED");
  });
});
