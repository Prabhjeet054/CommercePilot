import { randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { DEMO_SHOE_PRICE, DEMO_SHOE_PRODUCT_ID } from "../src/modules/catalog/catalog.constants";
import {
  AmountBelowMinimumError,
  amountInPaise,
  createRazorpayOrder,
} from "../src/modules/payments/create-order";
import { createInternalOrder } from "../src/modules/orders/order.service";
import {
  MIN_ORDER_AMOUNT_PAISE,
  RazorpayApiError,
  setRazorpayClientForTests,
  type RazorpayOrderCreateInput,
  type RazorpayOrdersClient,
} from "../src/modules/payments/razorpay-client";
import { seedCatalog } from "../prisma/seed";

const JWT_SECRET = "payments-api-access-secret";
const JWT_REFRESH_SECRET = "payments-api-refresh-secret";

process.env.RAZORPAY_KEY_ID = "rzp_test_replace_me";
process.env.RAZORPAY_KEY_SECRET = "replace-me";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

function uniqueEmail(prefix = "payments-test"): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

function clientIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

class RecordingRazorpayClient implements RazorpayOrdersClient {
  readonly calls: RazorpayOrderCreateInput[] = [];
  nextId = `order_test_${randomUUID().slice(0, 8)}`;
  fail = false;

  async createOrder(input: RazorpayOrderCreateInput) {
    this.calls.push(input);
    if (this.fail) {
      throw new RazorpayApiError("simulated auth failure", { statusCode: 400 });
    }
    return { id: this.nextId, amount: input.amount, currency: input.currency };
  }

  async fetchOrder(razorpayOrderId: string) {
    return { id: razorpayOrderId, status: "created" };
  }

  async fetchOrderPayments() {
    return [];
  }
}

async function registerCustomer(prefix = "payments-test") {
  const email = uniqueEmail(prefix);
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Payments User", role: "customer" });
  expect(response.status).toBe(201);
  return {
    email,
    token: response.body.accessToken as string,
    user: response.body.user as { id: string },
  };
}

async function createPayableIntent(userId: string, status = "POLICY_ALLOWED") {
  return prisma.purchaseIntent.create({
    data: {
      userId,
      rawText: "I need running shoes under ₹5,000.",
      structuredIntent: { category: "Sports" },
      purchaseMode: "autonomous",
      status,
      agentRun: {
        create: {
          status: "COMPLETED",
          decisions: {
            create: {
              productId: DEMO_SHOE_PRODUCT_ID,
              selected: true,
              rank: 1,
            },
          },
        },
      },
    },
  });
}

describe("amountInPaise", () => {
  it("is the single rupee→paise conversion (₹4,499 → 449900)", () => {
    expect(amountInPaise(DEMO_SHOE_PRICE)).toBe(449900);
    expect(amountInPaise(1)).toBe(100);
    expect(MIN_ORDER_AMOUNT_PAISE).toBe(100);
  });
});

describe("POST /payments/create-order", () => {
  let razorpay: RecordingRazorpayClient;

  beforeAll(async () => {
    await seedCatalog();
  });

  afterEach(() => {
    setRazorpayClientForTests(null);
  });

  beforeEach(() => {
    razorpay = new RecordingRazorpayClient();
    setRazorpayClientForTests(razorpay);
  });

  afterAll(async () => {
    await prisma.order.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "payments-test" } } } },
    });
    await prisma.agentDecision.deleteMany({
      where: { agentRun: { purchaseIntent: { user: { email: { startsWith: "payments-test" } } } } },
    });
    await prisma.agentRun.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "payments-test" } } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "payments-test" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "payments-test" } } });
    await prisma.$disconnect();
  });

  it("returns 401 without a bearer token", async () => {
    const response = await request(app).post("/payments/create-order").send({ purchaseIntentId: randomUUID() });
    expect(response.status).toBe(401);
  });

  it("returns 403 for a merchant_admin", async () => {
    const email = uniqueEmail("payments-test-admin");
    const registered = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({ email, password: "password12", name: "Admin", role: "merchant_admin" });
    expect(registered.status).toBe(201);

    const response = await request(app)
      .post("/payments/create-order")
      .set(authHeader(registered.body.accessToken))
      .send({ purchaseIntentId: randomUUID() });
    expect(response.status).toBe(403);
  });

  it("creates a Test Mode order for the ₹4,499 shoe and is idempotent", async () => {
    const customer = await registerCustomer();
    const intent = await createPayableIntent(customer.user.id);

    const first = await request(app)
      .post("/payments/create-order")
      .set(authHeader(customer.token))
      .send({ purchaseIntentId: intent.id });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      razorpayOrderId: razorpay.nextId,
      amount: 449900,
      currency: "INR",
      keyId: "rzp_test_replace_me",
    });
    expect(razorpay.calls).toHaveLength(1);
    expect(razorpay.calls[0]).toMatchObject({
      amount: 449900,
      currency: "INR",
      receipt: intent.id,
      notes: {
        source: "commercepilot_agent",
        purchase_intent_id: intent.id,
        autonomous: "true",
      },
    });

    const stored = await prisma.order.findUniqueOrThrow({ where: { purchaseIntentId: intent.id } });
    expect(stored.razorpayOrderId).toBe(razorpay.nextId);
    expect(stored.state).toBe("ORDER_CREATED");
    const intentRow = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(intentRow.status).toBe("ORDER_CREATED");

    const second = await request(app)
      .post("/payments/create-order")
      .set(authHeader(customer.token))
      .send({ purchaseIntentId: intent.id });

    expect(second.status).toBe(200);
    expect(second.body.razorpayOrderId).toBe(first.body.razorpayOrderId);
    expect(razorpay.calls).toHaveLength(1);
    expect(await prisma.order.count({ where: { purchaseIntentId: intent.id } })).toBe(1);
  });

  it("ignores a client-supplied amount and charges the catalog product price", async () => {
    const customer = await registerCustomer();
    const intent = await createPayableIntent(customer.user.id);

    const response = await request(app)
      .post("/payments/create-order")
      .set(authHeader(customer.token))
      .send({
        purchaseIntentId: intent.id,
        amount: 1,
        amountInPaise: 100,
        currency: "USD",
        razorpayOrderId: "order_forged_by_client",
      });

    expect(response.status).toBe(200);
    expect(response.body.amount).toBe(449900);
    expect(response.body.currency).toBe("INR");
    expect(response.body.razorpayOrderId).toBe(razorpay.nextId);
    expect(response.body.razorpayOrderId).not.toBe("order_forged_by_client");
    expect(razorpay.calls).toHaveLength(1);
    expect(razorpay.calls[0]?.amount).toBe(449900);
    expect(razorpay.calls[0]?.amount).not.toBe(1);
    expect(razorpay.calls[0]?.currency).toBe("INR");

    const stored = await prisma.order.findUniqueOrThrow({ where: { purchaseIntentId: intent.id } });
    expect(stored.amount.toFixed(2)).toBe(DEMO_SHOE_PRICE);
    expect(stored.razorpayOrderId).toBe(razorpay.nextId);
  });

  it("returns 404 (not 403) for another customer's purchase intent", async () => {
    const owner = await registerCustomer();
    const other = await registerCustomer();
    const intent = await createPayableIntent(owner.user.id);

    const response = await request(app)
      .post("/payments/create-order")
      .set(authHeader(other.token))
      .send({ purchaseIntentId: intent.id });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("NOT_FOUND");
    expect(razorpay.calls).toHaveLength(0);
  });

  it("returns 409 for POLICY_DENIED and does not call Razorpay", async () => {
    const customer = await registerCustomer();
    const intent = await createPayableIntent(customer.user.id, "POLICY_DENIED");

    const response = await request(app)
      .post("/payments/create-order")
      .set(authHeader(customer.token))
      .send({ purchaseIntentId: intent.id });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("NOT_PAYABLE");
    expect(razorpay.calls).toHaveLength(0);
    expect(await prisma.order.count({ where: { purchaseIntentId: intent.id } })).toBe(0);
  });

  it("leaves POLICY_ALLOWED unchanged when Razorpay fails", async () => {
    const customer = await registerCustomer();
    const intent = await createPayableIntent(customer.user.id);
    razorpay.fail = true;

    const response = await request(app)
      .post("/payments/create-order")
      .set(authHeader(customer.token))
      .send({ purchaseIntentId: intent.id });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("RAZORPAY_ERROR");
    expect(razorpay.calls).toHaveLength(1);

    const stored = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(stored.status).toBe("POLICY_ALLOWED");
    expect(await prisma.order.count({ where: { purchaseIntentId: intent.id } })).toBe(0);
  });

  it("rejects amounts below 100 paise before calling Razorpay", async () => {
    const customer = await registerCustomer();
    const intent = await prisma.purchaseIntent.create({
      data: {
        userId: customer.user.id,
        rawText: "cheap item",
        structuredIntent: {},
        purchaseMode: "manual",
        status: "POLICY_ALLOWED",
      },
    });
    const order = await createInternalOrder({
      purchaseIntentId: intent.id,
      productId: DEMO_SHOE_PRODUCT_ID,
      amount: 0.5,
    });

    await expect(createRazorpayOrder(order.id)).rejects.toBeInstanceOf(AmountBelowMinimumError);
    expect(razorpay.calls).toHaveLength(0);
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.razorpayOrderId).toBeNull();
  });
});
