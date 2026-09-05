import { randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/lib/prisma";
import { DEMO_SHOE_PRODUCT_ID } from "../src/modules/catalog/catalog.constants";
import { applyOrderLifecycleEvent, createInternalOrder } from "../src/modules/orders/order.service";
import {
  setRazorpayClientForTests,
  type RazorpayFetchedPayment,
  type RazorpayOrderCreateInput,
  type RazorpayOrdersClient,
} from "../src/modules/payments/razorpay-client";
import {
  getReconcileConfig,
  reconcileOrder,
  RECONCILE_EXHAUSTED_MESSAGE,
} from "../src/modules/payments/reconcile";
import { handleRazorpayWebhook } from "../src/modules/webhooks/webhook.service";
import { seedCatalog } from "../prisma/seed";

process.env.PAYMENT_RECONCILE_TIMEOUT_SECONDS = "0";
process.env.PAYMENT_RECONCILE_MAX_ATTEMPTS = "3";
process.env.PAYMENT_RECONCILE_BACKOFF_MS = "0,0,0";
process.env.RAZORPAY_KEY_ID = "rzp_test_phase22";
process.env.RAZORPAY_KEY_SECRET = "phase22-key-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "phase22-webhook-secret";

const JWT_SECRET = "phase22-access-secret!!";
const JWT_REFRESH_SECRET = "phase22-refresh-secret!";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

class ReconcileRazorpayClient implements RazorpayOrdersClient {
  readonly createCalls: RazorpayOrderCreateInput[] = [];
  readonly fetchOrderCalls: string[] = [];
  readonly fetchPaymentsCalls: string[] = [];
  orderStatus = "attempted";
  payments: RazorpayFetchedPayment[] = [];
  private fetchFailuresLeft = 0;

  resetFailures(times: number): void {
    this.fetchFailuresLeft = times;
  }

  async createOrder(input: RazorpayOrderCreateInput) {
    this.createCalls.push(input);
    return {
      id: `order_created_${this.createCalls.length}_${randomUUID().slice(0, 6)}`,
      amount: input.amount,
      currency: input.currency,
    };
  }

  async fetchOrder(razorpayOrderId: string) {
    this.fetchOrderCalls.push(razorpayOrderId);
    if (this.fetchFailuresLeft > 0) {
      this.fetchFailuresLeft -= 1;
      throw new Error("simulated Razorpay unreachable");
    }
    return { id: razorpayOrderId, status: this.orderStatus };
  }

  async fetchOrderPayments(razorpayOrderId: string) {
    this.fetchPaymentsCalls.push(razorpayOrderId);
    return this.payments.map((p) => ({ ...p, order_id: razorpayOrderId }));
  }
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function clientIp(): string {
  return `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
}

async function registerCustomer(prefix = "reconcile") {
  const email = `${prefix}-${randomUUID()}@example.com`;
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Reconcile User", role: "customer" });
  expect(response.status).toBe(201);
  return {
    email,
    token: response.body.accessToken as string,
    userId: response.body.user.id as string,
  };
}

async function createPayableIntent(userId: string) {
  return prisma.purchaseIntent.create({
    data: {
      userId,
      rawText: "I need running shoes under ₹5,000.",
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

async function seedStuckOrder(
  userId: string,
  status: "PAYMENT_PENDING" | "PAYMENT_AUTHORIZED",
) {
  const intent = await createPayableIntent(userId);
  const razorpayOrderId = `order_rec_${randomUUID().slice(0, 8)}`;
  const order = await createInternalOrder({
    purchaseIntentId: intent.id,
    productId: DEMO_SHOE_PRODUCT_ID,
    amount: 4499,
    razorpayOrderId,
  });
  await applyOrderLifecycleEvent(order.id, "checkout_opened");
  if (status === "PAYMENT_AUTHORIZED") {
    await applyOrderLifecycleEvent(order.id, "signature_verified");
  }

  const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(refreshed.state).toBe(status);
  return { intent, order: refreshed, razorpayOrderId };
}

describe("Phase 22 validation — PRD Section 20 recovery table", () => {
  let razorpay: ReconcileRazorpayClient;

  beforeAll(async () => {
    await seedCatalog();
  });

  beforeEach(() => {
    razorpay = new ReconcileRazorpayClient();
    setRazorpayClientForTests(razorpay);
    process.env.PAYMENT_RECONCILE_TIMEOUT_SECONDS = "0";
    process.env.PAYMENT_RECONCILE_MAX_ATTEMPTS = "3";
    process.env.PAYMENT_RECONCILE_BACKOFF_MS = "0,0,0";
  });

  afterEach(async () => {
    setRazorpayClientForTests(null);
    await prisma.webhookEvent.deleteMany({
      where: { eventId: { startsWith: "evt_phase22_" } },
    });
    await prisma.payment.deleteMany({
      where: { order: { purchaseIntent: { user: { email: { startsWith: "reconcile" } } } } },
    });
    await prisma.auditLog.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "reconcile" } } } },
    });
    await prisma.order.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "reconcile" } } } },
    });
    await prisma.agentDecision.deleteMany({
      where: { agentRun: { purchaseIntent: { user: { email: { startsWith: "reconcile" } } } } },
    });
    await prisma.agentRun.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "reconcile" } } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "reconcile" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "reconcile" } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("§20 client failure / dropped webhook — actually captured → COMPLETED via status-fetch", async () => {
    const customer = await registerCustomer("reconcile-captured");
    const { order, razorpayOrderId } = await seedStuckOrder(customer.userId, "PAYMENT_AUTHORIZED");

    razorpay.orderStatus = "paid";
    razorpay.payments = [
      { id: `pay_${randomUUID().slice(0, 8)}`, status: "captured", order_id: razorpayOrderId },
    ];

    const result = await reconcileOrder(order.id, { client: razorpay, sleep: async () => undefined });

    expect(result.outcome).toBe("completed");
    expect(result.orderState).toBe("COMPLETED");
    expect(razorpay.createCalls).toHaveLength(0);
    expect(razorpay.fetchOrderCalls.length).toBe(1);

    const attempts = await prisma.auditLog.findMany({
      where: { purchaseIntentId: order.purchaseIntentId, action: "payment_reconcile_attempt" },
    });
    expect(attempts).toHaveLength(1);
  });

  it("§20 client failure / dropped webhook — actually failed → PAYMENT_FAILED via status-fetch", async () => {
    const customer = await registerCustomer("reconcile-failed");
    const { order, razorpayOrderId } = await seedStuckOrder(customer.userId, "PAYMENT_PENDING");

    razorpay.orderStatus = "attempted";
    razorpay.payments = [
      { id: `pay_${randomUUID().slice(0, 8)}`, status: "failed", order_id: razorpayOrderId },
    ];

    const result = await reconcileOrder(order.id, { client: razorpay, sleep: async () => undefined });

    expect(result.outcome).toBe("failed");
    expect(result.orderState).toBe("PAYMENT_FAILED");
    expect(razorpay.createCalls).toHaveLength(0);

    const attempts = await prisma.auditLog.findMany({
      where: { purchaseIntentId: order.purchaseIntentId, action: "payment_reconcile_attempt" },
    });
    expect(attempts).toHaveLength(1);

    const failedAudits = await prisma.auditLog.findMany({
      where: { purchaseIntentId: order.purchaseIntentId, action: "payment_failed" },
    });
    expect(failedAudits.some((row) => {
      const payload = row.payload as { source?: string } | null;
      return payload?.source === "reconcile";
    })).toBe(true);
  });

  it("§20 silence is not failure — still-pending status-fetch never marks PAYMENT_FAILED", async () => {
    const customer = await registerCustomer("reconcile-silence");
    const { order } = await seedStuckOrder(customer.userId, "PAYMENT_PENDING");
    razorpay.orderStatus = "attempted";
    razorpay.payments = [];

    const result = await reconcileOrder(order.id, { client: razorpay, sleep: async () => undefined });
    expect(result.outcome).toBe("exhausted");
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.state).toBe("PAYMENT_PENDING");
  });

  it("§20 signature invalid — reconciliation does not treat VERIFICATION_FAILED as pending", async () => {
    const customer = await registerCustomer("reconcile-mismatch");
    const { order, razorpayOrderId } = await seedStuckOrder(customer.userId, "PAYMENT_PENDING");
    await applyOrderLifecycleEvent(order.id, "signature_invalid");

    // Even if Razorpay would report captured, reconcile must not run the stuck-pending path.
    razorpay.orderStatus = "paid";
    razorpay.payments = [
      { id: `pay_${randomUUID().slice(0, 8)}`, status: "captured", order_id: razorpayOrderId },
    ];

    const result = await reconcileOrder(order.id, { client: razorpay, sleep: async () => undefined });
    expect(result.outcome).toBe("unchanged");
    expect(result.orderState).toBe("PAYMENT_VERIFICATION_FAILED");
    expect(razorpay.fetchOrderCalls).toHaveLength(0);
    expect(razorpay.createCalls).toHaveLength(0);

    const attempts = await prisma.auditLog.count({
      where: { purchaseIntentId: order.purchaseIntentId, action: "payment_reconcile_attempt" },
    });
    expect(attempts).toBe(0);

    const retry = await request(app)
      .post(`/payments/${order.id}/retry`)
      .set(authHeader(customer.token));
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe("PAYMENT_VERIFICATION_FAILED");
  });

  it("§20 webhook never arrives within timeout → COMPLETED via API fetch", async () => {
    const customer = await registerCustomer("reconcile-timeout");
    const { order, razorpayOrderId } = await seedStuckOrder(customer.userId, "PAYMENT_AUTHORIZED");
    razorpay.orderStatus = "paid";
    razorpay.payments = [
      { id: `pay_${randomUUID().slice(0, 8)}`, status: "captured", order_id: razorpayOrderId },
    ];

    const result = await reconcileOrder(order.id, {
      client: razorpay,
      sleep: async () => undefined,
      // timeoutSeconds=0 in test env — age gate already open
    });
    expect(result.outcome).toBe("completed");
    expect(result.orderState).toBe("COMPLETED");
  });

  it("§20 duplicate reconcile on COMPLETED is a safe no-op (no new attempt audits, no error)", async () => {
    const customer = await registerCustomer("reconcile-noop");
    const { order, razorpayOrderId } = await seedStuckOrder(customer.userId, "PAYMENT_AUTHORIZED");
    razorpay.orderStatus = "paid";
    razorpay.payments = [
      { id: `pay_${randomUUID().slice(0, 8)}`, status: "captured", order_id: razorpayOrderId },
    ];
    await reconcileOrder(order.id, { client: razorpay, sleep: async () => undefined });

    const auditsBefore = await prisma.auditLog.count({
      where: { purchaseIntentId: order.purchaseIntentId },
    });
    const attemptsBefore = await prisma.auditLog.count({
      where: { purchaseIntentId: order.purchaseIntentId, action: "payment_reconcile_attempt" },
    });

    const again = await reconcileOrder(order.id, { client: razorpay, sleep: async () => undefined });
    expect(again.outcome).toBe("noop");
    expect(again.orderState).toBe("COMPLETED");
    expect(again.attemptsThisRun).toBe(0);

    const auditsAfter = await prisma.auditLog.count({
      where: { purchaseIntentId: order.purchaseIntentId },
    });
    const attemptsAfter = await prisma.auditLog.count({
      where: { purchaseIntentId: order.purchaseIntentId, action: "payment_reconcile_attempt" },
    });
    expect(attemptsAfter).toBe(attemptsBefore);
    expect(auditsAfter).toBe(auditsBefore);
    expect(razorpay.fetchOrderCalls.length).toBe(1); // no second fetch on noop
  });

  it("§20 network drop mid-checkout — retry resumes same razorpay_order_id (no second create)", async () => {
    const customer = await registerCustomer("reconcile-resume");
    const intent = await createPayableIntent(customer.userId);

    const created = await request(app)
      .post("/payments/create-order")
      .set(authHeader(customer.token))
      .send({ purchaseIntentId: intent.id });
    expect(created.status).toBe(200);
    expect(razorpay.createCalls).toHaveLength(1);
    const razorpayOrderId = created.body.razorpayOrderId as string;

    const order = await prisma.order.findUniqueOrThrow({ where: { purchaseIntentId: intent.id } });
    await applyOrderLifecycleEvent(order.id, "checkout_opened");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).state).toBe(
      "PAYMENT_PENDING",
    );

    // Gateway still unpaid — reconcile should not block Checkout resume.
    razorpay.orderStatus = "created";
    razorpay.payments = [];

    const resumed = await request(app)
      .post(`/payments/${order.id}/retry`)
      .set(authHeader(customer.token));
    expect(resumed.status).toBe(200);
    expect(resumed.body.razorpayOrderId).toBe(razorpayOrderId);
    expect(resumed.body.orderState).toBe("PAYMENT_PENDING");
    expect(razorpay.createCalls).toHaveLength(1);
  });

  it("§20 retry storm — 5× retry after one create-order → exactly one Orders.create total", async () => {
    const customer = await registerCustomer("reconcile-storm");
    const intent = await createPayableIntent(customer.userId);

    const created = await request(app)
      .post("/payments/create-order")
      .set(authHeader(customer.token))
      .send({ purchaseIntentId: intent.id });
    expect(created.status).toBe(200);
    const razorpayOrderId = created.body.razorpayOrderId as string;
    expect(razorpay.createCalls).toHaveLength(1);

    const order = await prisma.order.findUniqueOrThrow({ where: { purchaseIntentId: intent.id } });
    // Stay ORDER_CREATED (tab closed before checkout_opened) — pure resume storm.
    razorpay.orderStatus = "created";
    razorpay.payments = [];

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post(`/payments/${order.id}/retry`).set(authHeader(customer.token)),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body.razorpayOrderId).toBe(razorpayOrderId);
    }
    expect(razorpay.createCalls).toHaveLength(1);
  });

  it("concurrency: webhook + reconcile finalize the same order → COMPLETED, no unhandled throw", async () => {
    const customer = await registerCustomer("reconcile-race");
    const { order, razorpayOrderId } = await seedStuckOrder(customer.userId, "PAYMENT_AUTHORIZED");

    const paymentId = `pay_${randomUUID().slice(0, 8)}`;
    razorpay.orderStatus = "paid";
    razorpay.payments = [{ id: paymentId, status: "captured", order_id: razorpayOrderId }];

    const raw = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: paymentId, order_id: razorpayOrderId, status: "captured" },
          },
        },
      }),
    );

    const settled = await Promise.allSettled([
      reconcileOrder(order.id, { client: razorpay, sleep: async () => undefined }),
      handleRazorpayWebhook({
        rawBody: raw,
        eventId: `evt_phase22_${randomUUID()}`,
        signatureValid: true,
      }),
    ]);

    for (const result of settled) {
      expect(result.status).toBe("fulfilled");
    }

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.state).toBe("COMPLETED");
  });

  it("retry cap: 4 reconcile invocations stop after 3 status-fetch attempts with terminal exhausted", async () => {
    const customer = await registerCustomer("reconcile-cap");
    const { order } = await seedStuckOrder(customer.userId, "PAYMENT_AUTHORIZED");
    razorpay.orderStatus = "attempted";
    razorpay.payments = [];

    const outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      outcomes.push(
        await reconcileOrder(order.id, { client: razorpay, sleep: async () => undefined }),
      );
    }

    expect(outcomes[0]?.outcome).toBe("exhausted");
    expect(outcomes[0]?.attemptsThisRun).toBe(3);
    expect(outcomes[1]?.outcome).toBe("exhausted");
    expect(outcomes[1]?.attemptsThisRun).toBe(0);
    expect(outcomes[2]?.attemptsThisRun).toBe(0);
    expect(outcomes[3]?.attemptsThisRun).toBe(0);
    expect(razorpay.fetchOrderCalls).toHaveLength(3);
    expect(outcomes.every((o) => o.message === RECONCILE_EXHAUSTED_MESSAGE)).toBe(true);

    const attempts = await prisma.auditLog.count({
      where: { purchaseIntentId: order.purchaseIntentId, action: "payment_reconcile_attempt" },
    });
    expect(attempts).toBe(3);

    const exhausted = await prisma.auditLog.count({
      where: { purchaseIntentId: order.purchaseIntentId, action: "payment_reconcile_exhausted" },
    });
    expect(exhausted).toBe(1);

    // AUTHORIZED + exhausted → retry endpoint surfaces terminal error
    const retry = await request(app)
      .post(`/payments/${order.id}/retry`)
      .set(authHeader(customer.token));
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe("RECONCILE_EXHAUSTED");
  });

  it("every reconcile attempt (success or failure) writes payment_reconcile_attempt audit", async () => {
    const customer = await registerCustomer("reconcile-audit");
    const { order, razorpayOrderId } = await seedStuckOrder(customer.userId, "PAYMENT_PENDING");

    razorpay.resetFailures(1);
    razorpay.orderStatus = "paid";
    razorpay.payments = [
      { id: `pay_${randomUUID().slice(0, 8)}`, status: "captured", order_id: razorpayOrderId },
    ];

    const result = await reconcileOrder(order.id, { client: razorpay, sleep: async () => undefined });
    expect(result.outcome).toBe("completed");
    // attempt 1 failed fetch (still audited), attempt 2 succeeded
    expect(result.attemptsThisRun).toBe(2);

    const attempts = await prisma.auditLog.findMany({
      where: { purchaseIntentId: order.purchaseIntentId, action: "payment_reconcile_attempt" },
      orderBy: { createdAt: "asc" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => (a.payload as { attempt: number }).attempt)).toEqual([1, 2]);
  });

  it("IDOR: retry for another user's order returns 404", async () => {
    const owner = await registerCustomer("reconcile-owner");
    const other = await registerCustomer("reconcile-other");
    const { order } = await seedStuckOrder(owner.userId, "PAYMENT_PENDING");

    const response = await request(app)
      .post(`/payments/${order.id}/retry`)
      .set(authHeader(other.token));
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("NOT_FOUND");
  });

  it("transient Razorpay fetch errors are retried within the cap without crashing", async () => {
    const customer = await registerCustomer("reconcile-apierr");
    const { order, razorpayOrderId } = await seedStuckOrder(customer.userId, "PAYMENT_AUTHORIZED");
    razorpay.resetFailures(2);
    razorpay.orderStatus = "paid";
    razorpay.payments = [
      { id: `pay_${randomUUID().slice(0, 8)}`, status: "captured", order_id: razorpayOrderId },
    ];

    const result = await reconcileOrder(order.id, { client: razorpay, sleep: async () => undefined });
    expect(result.outcome).toBe("completed");
    expect(result.orderState).toBe("COMPLETED");
    expect(razorpay.fetchOrderCalls.length).toBe(3);
  });
});

describe("Phase 22 reconcile config defaults", () => {
  it("documents demo timeout 60s, max 3 attempts, backoff 1s/4s/16s", () => {
    const defaults = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://commercepilot:commercepilot@localhost:5432/commercepilot",
      FRONTEND_URL: "http://localhost:5173",
      JWT_SECRET: "phase3-dev-access-secret-change-me",
      JWT_REFRESH_SECRET: "phase3-dev-refresh-secret-change-me",
    });
    const config = getReconcileConfig(defaults);
    expect(config.timeoutMs).toBe(60_000);
    expect(config.maxAttempts).toBe(3);
    expect(config.backoffMs).toEqual([1000, 4000, 16000]);
  });
});
