import { createHmac, randomUUID } from "crypto";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { DEMO_SHOE_PRODUCT_ID } from "../src/modules/catalog/catalog.constants";
import { applyOrderLifecycleEvent, createInternalOrder } from "../src/modules/orders/order.service";
import {
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
} from "../src/modules/webhooks/webhook.service";
import { createWebhookRouter } from "../src/modules/webhooks/webhook.routes";
import { seedCatalog } from "../prisma/seed";

const JWT_SECRET = "webhooks-access-secret!!";
const JWT_REFRESH_SECRET = "webhooks-refresh-secret!";
const WEBHOOK_SECRET = "phase18-webhook-secret";

process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.RAZORPAY_KEY_ID = "rzp_test_phase18";
process.env.RAZORPAY_KEY_SECRET = "phase18-key-secret";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

function sign(rawBody: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
}

/** Send as a UTF-8 string — SuperAgent JSON-serializes Buffer into a byte array, which breaks HMAC. */
function postWebhook(raw: string, headers: Record<string, string>) {
  return request(app).post("/webhooks/razorpay").set(headers).send(raw);
}

function paymentCapturedPayload(razorpayOrderId: string, paymentId: string) {
  return {
    entity: "event",
    account_id: "acc_test",
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: "payment",
          amount: 449900,
          currency: "INR",
          status: "captured",
          order_id: razorpayOrderId,
          method: "card",
          captured: true,
          email: "buyer@example.com",
          contact: "+919999999999",
          created_at: Math.floor(Date.now() / 1000),
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  };
}

async function seedUserAndOrder(status: "ORDER_CREATED" | "PAYMENT_PENDING" | "PAYMENT_AUTHORIZED") {
  const email = `webhook-${randomUUID()}@example.com`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: "x".repeat(60),
      role: "customer",
      name: "Webhook Tester",
    },
  });
  const intent = await prisma.purchaseIntent.create({
    data: {
      userId: user.id,
      rawText: "shoe",
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
  const razorpayOrderId = `order_wh_${randomUUID().slice(0, 8)}`;
  const order = await createInternalOrder({
    purchaseIntentId: intent.id,
    productId: DEMO_SHOE_PRODUCT_ID,
    amount: 4499,
    razorpayOrderId,
  });

  if (status === "PAYMENT_PENDING" || status === "PAYMENT_AUTHORIZED") {
    await applyOrderLifecycleEvent(order.id, "checkout_opened");
  }
  if (status === "PAYMENT_AUTHORIZED") {
    await applyOrderLifecycleEvent(order.id, "signature_verified");
  }

  const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(refreshed.state).toBe(status);
  return { user, intent, order: refreshed, razorpayOrderId, email };
}

describe("POST /webhooks/razorpay", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  afterEach(async () => {
    await prisma.webhookEvent.deleteMany({
      where: { eventId: { startsWith: "evt_phase18_" } },
    });
    await prisma.payment.deleteMany({
      where: { order: { purchaseIntent: { user: { email: { startsWith: "webhook-" } } } } },
    });
    await prisma.order.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "webhook-" } } } },
    });
    await prisma.agentDecision.deleteMany({
      where: { agentRun: { purchaseIntent: { user: { email: { startsWith: "webhook-" } } } } },
    });
    await prisma.agentRun.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "webhook-" } } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "webhook-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "webhook-" } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects an invalid signature with 400 before any WebhookEvent write", async () => {
    const { razorpayOrderId } = await seedUserAndOrder("PAYMENT_AUTHORIZED");
    const payload = paymentCapturedPayload(razorpayOrderId, `pay_${randomUUID().slice(0, 8)}`);
    const raw = JSON.stringify(payload);
    const before = await prisma.webhookEvent.count();

    const response = await postWebhook(raw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: "deadbeef",
      [RAZORPAY_EVENT_ID_HEADER]: `evt_phase18_${randomUUID()}`,
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_WEBHOOK_SIGNATURE");
    expect(await prisma.webhookEvent.count()).toBe(before);
  });

  it("receives a raw Buffer body (fails closed if JSON middleware had consumed the stream)", async () => {
    // Route is mounted with express.raw before express.json — success proves req.body
    // stayed a Buffer (object body would 500 WEBHOOK_RAW_BODY_REQUIRED).
    const { razorpayOrderId, order } = await seedUserAndOrder("PAYMENT_AUTHORIZED");
    const eventId = `evt_phase18_${randomUUID()}`;
    const payload = paymentCapturedPayload(razorpayOrderId, `pay_${randomUUID().slice(0, 8)}`);
    const raw = JSON.stringify(payload);

    const response = await postWebhook(raw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(raw),
      [RAZORPAY_EVENT_ID_HEADER]: eventId,
    });

    expect(response.status).toBe(200);
    expect(response.body.received).toBe(true);
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.state).toBe("COMPLETED");
    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId } });
    expect(event.signatureValid).toBe(true);
    expect(event.rawPayload).toMatchObject({ event: "payment.captured" });
  });

  it("rejects with 500 when body was pre-parsed as JSON (raw Buffer missing)", async () => {
    const broken = express();
    broken.use(express.json());
    broken.use("/webhooks", createWebhookRouter());
    const raw = JSON.stringify({ event: "payment.captured" });
    const response = await request(broken)
      .post("/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set(RAZORPAY_SIGNATURE_HEADER, sign(raw))
      .set(RAZORPAY_EVENT_ID_HEADER, `evt_phase18_${randomUUID()}`)
      .send(raw);
    expect(response.status).toBe(500);
    expect(response.body.error).toBe("WEBHOOK_RAW_BODY_REQUIRED");
  });

  it("deduplicates an identical replay (same event id) with 200 and no second transition", async () => {
    const { razorpayOrderId, order } = await seedUserAndOrder("PAYMENT_AUTHORIZED");
    const eventId = `evt_phase18_${randomUUID()}`;
    const payload = paymentCapturedPayload(razorpayOrderId, `pay_${randomUUID().slice(0, 8)}`);
    const raw = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(raw),
      [RAZORPAY_EVENT_ID_HEADER]: eventId,
    };

    const first = await postWebhook(raw, headers);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();

    const second = await postWebhook(raw, headers);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1);
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.state).toBe("COMPLETED");
  });

  it("PAYMENT_PENDING → COMPLETED when webhook arrives without Phase 17 verify", async () => {
    const { razorpayOrderId, order } = await seedUserAndOrder("PAYMENT_PENDING");
    const eventId = `evt_phase18_${randomUUID()}`;
    const payload = paymentCapturedPayload(razorpayOrderId, `pay_${randomUUID().slice(0, 8)}`);
    const raw = JSON.stringify(payload);

    const response = await postWebhook(raw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(raw),
      [RAZORPAY_EVENT_ID_HEADER]: eventId,
    });

    expect(response.status).toBe(200);
    expect(response.body.orderState).toBe("COMPLETED");
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { purchaseIntent: true },
    });
    expect(stored.state).toBe("COMPLETED");
    expect(stored.purchaseIntent.status).toBe("COMPLETED");
  });

  it("returns 200 (ignored) for an unknown Razorpay order id without retrying forever", async () => {
    const eventId = `evt_phase18_${randomUUID()}`;
    const payload = paymentCapturedPayload("order_unknown_xyz", `pay_${randomUUID().slice(0, 8)}`);
    const raw = JSON.stringify(payload);

    const response = await postWebhook(raw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(raw),
      [RAZORPAY_EVENT_ID_HEADER]: eventId,
    });

    expect(response.status).toBe(200);
    expect(response.body.ignored).toBe(true);
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1);
  });

  it("transitions payment.failed from PAYMENT_PENDING to PAYMENT_FAILED", async () => {
    const { razorpayOrderId, order } = await seedUserAndOrder("PAYMENT_PENDING");
    const eventId = `evt_phase18_${randomUUID()}`;
    const payload = {
      entity: "event",
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: `pay_${randomUUID().slice(0, 8)}`,
            order_id: razorpayOrderId,
            status: "failed",
          },
        },
      },
    };
    const raw = JSON.stringify(payload);

    const response = await postWebhook(raw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(raw),
      [RAZORPAY_EVENT_ID_HEADER]: eventId,
    });

    expect(response.status).toBe(200);
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.state).toBe("PAYMENT_FAILED");
  });
});
