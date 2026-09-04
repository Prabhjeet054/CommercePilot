import { createHmac, randomUUID } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { signRazorpayCheckoutPayload } from "../src/lib/hmac";
import { prisma } from "../src/lib/prisma";
import { DEMO_SHOE_PRICE, DEMO_SHOE_PRODUCT_ID } from "../src/modules/catalog/catalog.constants";
import {
  setRazorpayClientForTests,
  type RazorpayOrderCreateInput,
  type RazorpayOrdersClient,
} from "../src/modules/payments/razorpay-client";
import { seedCatalog } from "../prisma/seed";

const JWT_SECRET = "payments-verify-access-secret";
const JWT_REFRESH_SECRET = "payments-verify-refresh-secret";
const RAZORPAY_SECRET = "phase17-test-key-secret";

process.env.RAZORPAY_KEY_ID = "rzp_test_phase17";
process.env.RAZORPAY_KEY_SECRET = RAZORPAY_SECRET;

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

function uniqueEmail(prefix = "verify-test"): string {
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

  async createOrder(input: RazorpayOrderCreateInput) {
    this.calls.push(input);
    return { id: this.nextId, amount: input.amount, currency: input.currency };
  }
}

async function registerCustomer() {
  const email = uniqueEmail();
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Verify User", role: "customer" });
  expect(response.status).toBe(201);
  return {
    token: response.body.accessToken as string,
    user: response.body.user as { id: string },
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

describe("POST /payments/verify", () => {
  let razorpay: RecordingRazorpayClient;

  beforeAll(async () => {
    await seedCatalog();
  });

  beforeEach(() => {
    razorpay = new RecordingRazorpayClient();
    setRazorpayClientForTests(razorpay);
  });

  afterEach(() => {
    setRazorpayClientForTests(null);
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({
      where: { order: { purchaseIntent: { user: { email: { startsWith: "verify-test" } } } } },
    });
    await prisma.order.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "verify-test" } } } },
    });
    await prisma.agentDecision.deleteMany({
      where: { agentRun: { purchaseIntent: { user: { email: { startsWith: "verify-test" } } } } },
    });
    await prisma.agentRun.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "verify-test" } } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "verify-test" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "verify-test" } } });
    await prisma.$disconnect();
  });

  async function createOrderFor(customer: { token: string; user: { id: string } }) {
    const intent = await createPayableIntent(customer.user.id);
    const created = await request(app)
      .post("/payments/create-order")
      .set(authHeader(customer.token))
      .send({ purchaseIntentId: intent.id });
    expect(created.status).toBe(200);
    return {
      intentId: intent.id,
      razorpayOrderId: created.body.razorpayOrderId as string,
      amount: created.body.amount as number,
    };
  }

  it("verifies a genuine Checkout signature and reaches PAYMENT_AUTHORIZED", async () => {
    const customer = await registerCustomer();
    const order = await createOrderFor(customer);
    const paymentId = `pay_ok_${randomUUID().slice(0, 8)}`;
    const signature = signRazorpayCheckoutPayload(order.razorpayOrderId, paymentId, RAZORPAY_SECRET);

    const response = await request(app)
      .post("/payments/verify")
      .set(authHeader(customer.token))
      .send({
        razorpay_order_id: order.razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ verified: true, orderState: "PAYMENT_AUTHORIZED" });

    const storedOrder = await prisma.order.findUniqueOrThrow({
      where: { razorpayOrderId: order.razorpayOrderId },
      include: { payments: true, purchaseIntent: true },
    });
    expect(storedOrder.state).toBe("PAYMENT_AUTHORIZED");
    expect(storedOrder.purchaseIntent.status).toBe("PAYMENT_AUTHORIZED");
    expect(storedOrder.payments).toHaveLength(1);
    expect(storedOrder.payments[0]?.signatureVerified).toBe(true);
    expect(storedOrder.payments[0]?.razorpayPaymentId).toBe(paymentId);
    expect(Number(DEMO_SHOE_PRICE) * 100).toBe(order.amount);
  });

  it("rejects a tampered signature with PAYMENT_VERIFICATION_FAILED and no Payment row", async () => {
    const customer = await registerCustomer();
    const order = await createOrderFor(customer);
    const paymentId = `pay_bad_${randomUUID().slice(0, 8)}`;
    const genuine = signRazorpayCheckoutPayload(order.razorpayOrderId, paymentId, RAZORPAY_SECRET);
    const tampered = `${genuine.slice(0, -1)}${genuine.endsWith("a") ? "b" : "a"}`;
    expect(tampered.length).toBe(genuine.length);
    expect(tampered).not.toBe(genuine);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await request(app)
      .post("/payments/verify")
      .set(authHeader(customer.token))
      .send({
        razorpay_order_id: order.razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: tampered,
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("SIGNATURE_MISMATCH");
    expect(response.body.reasonCode).toBe("SIGNATURE_MISMATCH");
    expect(response.body.orderState).toBe("PAYMENT_VERIFICATION_FAILED");

    const mismatchLogs = errorSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .filter((line) => line.includes("payment_verification_failed"));
    expect(mismatchLogs.length).toBeGreaterThan(0);
    expect(mismatchLogs.some((line) => line.includes("SIGNATURE_MISMATCH"))).toBe(true);
    expect(mismatchLogs.every((line) => !line.includes(RAZORPAY_SECRET))).toBe(true);
    errorSpy.mockRestore();

    const storedOrder = await prisma.order.findUniqueOrThrow({
      where: { razorpayOrderId: order.razorpayOrderId },
      include: { payments: true, purchaseIntent: true },
    });
    expect(storedOrder.state).toBe("PAYMENT_VERIFICATION_FAILED");
    expect(storedOrder.purchaseIntent.status).toBe("PAYMENT_VERIFICATION_FAILED");
    expect(storedOrder.payments).toHaveLength(0);
  });

  it("rejects a fabricated order/payment pair even when the HMAC is correctly computed", async () => {
    const customer = await registerCustomer();
    const fabricatedOrderId = `order_fabricated_${randomUUID().slice(0, 8)}`;
    const fabricatedPaymentId = `pay_fabricated_${randomUUID().slice(0, 8)}`;
    // Attacker knows the secret in this unit test — still rejected because order_id is absent.
    const signature = signRazorpayCheckoutPayload(fabricatedOrderId, fabricatedPaymentId, RAZORPAY_SECRET);

    const response = await request(app)
      .post("/payments/verify")
      .set(authHeader(customer.token))
      .send({
        razorpay_order_id: fabricatedOrderId,
        razorpay_payment_id: fabricatedPaymentId,
        razorpay_signature: signature,
      });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "NOT_FOUND" });
    expect(await prisma.order.count({ where: { razorpayOrderId: fabricatedOrderId } })).toBe(0);
    expect(await prisma.payment.count({ where: { razorpayPaymentId: fabricatedPaymentId } })).toBe(0);
  });

  it("ignores a client-supplied amount and has no amount field on the verify schema", async () => {
    const customer = await registerCustomer();
    const order = await createOrderFor(customer);
    const paymentId = `pay_amt_${randomUUID().slice(0, 8)}`;
    const signature = signRazorpayCheckoutPayload(order.razorpayOrderId, paymentId, RAZORPAY_SECRET);

    const response = await request(app)
      .post("/payments/verify")
      .set(authHeader(customer.token))
      .send({
        razorpay_order_id: order.razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
        amount: 1,
        amountInPaise: 100,
        currency: "USD",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ verified: true, orderState: "PAYMENT_AUTHORIZED" });

    const storedOrder = await prisma.order.findUniqueOrThrow({
      where: { razorpayOrderId: order.razorpayOrderId },
    });
    // Catalog shoe amount is unchanged — verify never rewrote Order.amount from the body.
    expect(storedOrder.amount.toFixed(2)).toBe(DEMO_SHOE_PRICE);

    const schemaSource = readFileSync(
      path.resolve(__dirname, "../src/modules/payments/payments.schema.ts"),
      "utf8",
    );
    const verifySource = readFileSync(
      path.resolve(__dirname, "../src/modules/payments/verify.ts"),
      "utf8",
    );
    expect(schemaSource).toMatch(/verifyPaymentBodySchema[\s\S]*\.strip\(\)/);
    expect(schemaSource).not.toMatch(/verifyPaymentBodySchema[\s\S]*\bamount\b/);
    expect(verifySource).not.toMatch(/\bamount\b/);
  });

  it("treats a repeat verify for an already-verified payment as a safe no-op", async () => {
    const customer = await registerCustomer();
    const order = await createOrderFor(customer);
    const paymentId = `pay_idem_${randomUUID().slice(0, 8)}`;
    const signature = signRazorpayCheckoutPayload(order.razorpayOrderId, paymentId, RAZORPAY_SECRET);
    const body = {
      razorpay_order_id: order.razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    };

    const first = await request(app).post("/payments/verify").set(authHeader(customer.token)).send(body);
    expect(first.status).toBe(200);

    const second = await request(app).post("/payments/verify").set(authHeader(customer.token)).send(body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ verified: true, orderState: "PAYMENT_AUTHORIZED" });

    const payments = await prisma.payment.findMany({
      where: { razorpayPaymentId: paymentId },
    });
    expect(payments).toHaveLength(1);
  });

  it("returns 404 for a fabricated razorpay_order_id without leaking existence details", async () => {
    const customer = await registerCustomer();
    const response = await request(app)
      .post("/payments/verify")
      .set(authHeader(customer.token))
      .send({
        razorpay_order_id: "order_does_not_exist",
        razorpay_payment_id: "pay_x",
        razorpay_signature: createHmac("sha256", RAZORPAY_SECRET).update("x").digest("hex"),
      });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "NOT_FOUND" });
  });

  it("returns 404 (not 403) when another customer tries to verify the order", async () => {
    const owner = await registerCustomer();
    const other = await registerCustomer();
    const order = await createOrderFor(owner);
    const paymentId = `pay_idor_${randomUUID().slice(0, 8)}`;
    const signature = signRazorpayCheckoutPayload(order.razorpayOrderId, paymentId, RAZORPAY_SECRET);

    const response = await request(app)
      .post("/payments/verify")
      .set(authHeader(other.token))
      .send({
        razorpay_order_id: order.razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });
    expect(response.status).toBe(404);
    expect(await prisma.payment.count({ where: { razorpayPaymentId: paymentId } })).toBe(0);
  });
});
