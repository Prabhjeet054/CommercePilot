import { createHmac, randomUUID } from "crypto";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import * as hmac from "../src/lib/hmac";
import { prisma } from "../src/lib/prisma";
import { DEMO_SHOE_PRODUCT_ID } from "../src/modules/catalog/catalog.constants";
import { applyOrderLifecycleEvent, createInternalOrder } from "../src/modules/orders/order.service";
import {
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
} from "../src/modules/webhooks/webhook.service";
import { createWebhookRouter } from "../src/modules/webhooks/webhook.routes";
import { seedCatalog } from "../prisma/seed";
import { capturedLogText } from "./setup";

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

function sign(rawBody: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
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

function paymentFailedPayload(razorpayOrderId: string, paymentId: string) {
  return {
    entity: "event",
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: razorpayOrderId,
          status: "failed",
        },
      },
    },
  };
}

async function seedUserAndOrder(
  status: "ORDER_CREATED" | "PAYMENT_PENDING" | "PAYMENT_AUTHORIZED" | "PAYMENT_FAILED",
) {
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

  if (
    status === "PAYMENT_PENDING" ||
    status === "PAYMENT_AUTHORIZED" ||
    status === "PAYMENT_FAILED"
  ) {
    await applyOrderLifecycleEvent(order.id, "checkout_opened");
  }
  if (status === "PAYMENT_AUTHORIZED") {
    await applyOrderLifecycleEvent(order.id, "signature_verified");
  }
  if (status === "PAYMENT_FAILED") {
    await applyOrderLifecycleEvent(order.id, "payment_failed_webhook");
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
    vi.restoreAllMocks();
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

  it("HMAC runs over the exact raw bytes received — not a re-serialized JSON object", async () => {
    // Spacing / key order that JSON.stringify(JSON.parse(...)) would collapse.
    // A naive express.json() → JSON.stringify(req.body) verifier would hash a
    // different string and fail this test while still "looking" correct with
    // compact fixtures.
    const { razorpayOrderId, order } = await seedUserAndOrder("PAYMENT_AUTHORIZED");
    const paymentId = `pay_${randomUUID().slice(0, 8)}`;
    const raw = `{ "event" : "payment.captured", "payload" : { "payment" : { "entity" : { "id" : "${paymentId}", "order_id" : "${razorpayOrderId}", "status" : "captured" } } } }\n`;
    const reSerialized = JSON.stringify(JSON.parse(raw));
    expect(reSerialized).not.toBe(raw);

    const spy = vi.spyOn(hmac, "verifySignature");
    const response = await postWebhook(raw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(raw),
      [RAZORPAY_EVENT_ID_HEADER]: `evt_phase18_${randomUUID()}`,
    });

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalled();
    const [payloadArg] = spy.mock.calls[0]!;
    expect(payloadArg).toBe(raw);
    expect(payloadArg).not.toBe(reSerialized);
    // Signing the re-serialized form must NOT match — proves the bug class is catchable.
    expect(hmac.verifySignature(reSerialized, sign(raw), WEBHOOK_SECRET)).toBe(false);

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.state).toBe("COMPLETED");
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

  it("correctly-signed payment.captured finalizes Order to COMPLETED", async () => {
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
    expect(response.body.orderState).toBe("COMPLETED");
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { purchaseIntent: true },
    });
    expect(stored.state).toBe("COMPLETED");
    expect(stored.purchaseIntent.status).toBe("COMPLETED");
    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId } });
    expect(event.signatureValid).toBe(true);
  });

  it("rejects a body-tampered webhook with 400 — no state change, no WebhookEvent row", async () => {
    const { razorpayOrderId, order } = await seedUserAndOrder("PAYMENT_AUTHORIZED");
    const payload = paymentCapturedPayload(razorpayOrderId, `pay_${randomUUID().slice(0, 8)}`);
    const raw = JSON.stringify(payload);
    const signature = sign(raw);
    // Tamper one byte after signing.
    const tampered = `${raw.slice(0, -2)}X${raw.slice(-1)}`;
    expect(tampered).not.toBe(raw);
    const beforeEvents = await prisma.webhookEvent.count();
    const beforeState = order.state;

    const response = await postWebhook(tampered, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: signature,
      [RAZORPAY_EVENT_ID_HEADER]: `evt_phase18_${randomUUID()}`,
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("INVALID_WEBHOOK_SIGNATURE");
    expect(await prisma.webhookEvent.count()).toBe(beforeEvents);
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.state).toBe(beforeState);
  });

  it("rejects a wrong-secret signature with 400 — no state change, no WebhookEvent row", async () => {
    const { razorpayOrderId, order } = await seedUserAndOrder("PAYMENT_AUTHORIZED");
    const payload = paymentCapturedPayload(razorpayOrderId, `pay_${randomUUID().slice(0, 8)}`);
    const raw = JSON.stringify(payload);
    const beforeEvents = await prisma.webhookEvent.count();

    const response = await postWebhook(raw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(raw, "wrong-webhook-secret"),
      [RAZORPAY_EVENT_ID_HEADER]: `evt_phase18_${randomUUID()}`,
    });

    expect(response.status).toBe(400);
    expect(await prisma.webhookEvent.count()).toBe(beforeEvents);
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.state).toBe("PAYMENT_AUTHORIZED");
  });

  it("deduplicates identical replay (same event id): 200, one WebhookEvent, no second transition", async () => {
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
    const afterFirst = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterFirst.state).toBe("COMPLETED");
    const updatedAtAfterFirst = afterFirst.updatedAt.getTime();

    const second = await postWebhook(raw, headers);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1);
    const afterSecond = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterSecond.state).toBe("COMPLETED");
    expect(afterSecond.updatedAt.getTime()).toBe(updatedAtAfterFirst);
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

  it("delayed/out-of-order: payment.failed then payment.captured recovers to COMPLETED", async () => {
    // Razorpay docs: failed attempt can be followed by a successful UPI retry /
    // late auth on the same order — capture must win, not leave the order stuck.
    const { razorpayOrderId, order } = await seedUserAndOrder("PAYMENT_PENDING");

    const failedRaw = JSON.stringify(
      paymentFailedPayload(razorpayOrderId, `pay_fail_${randomUUID().slice(0, 6)}`),
    );
    const failed = await postWebhook(failedRaw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(failedRaw),
      [RAZORPAY_EVENT_ID_HEADER]: `evt_phase18_${randomUUID()}`,
    });
    expect(failed.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).state).toBe(
      "PAYMENT_FAILED",
    );

    const capturedRaw = JSON.stringify(
      paymentCapturedPayload(razorpayOrderId, `pay_ok_${randomUUID().slice(0, 6)}`),
    );
    const captured = await postWebhook(capturedRaw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(capturedRaw),
      [RAZORPAY_EVENT_ID_HEADER]: `evt_phase18_${randomUUID()}`,
    });
    expect(captured.status).toBe(200);
    expect(captured.body.orderState).toBe("COMPLETED");
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { purchaseIntent: true },
    });
    expect(stored.state).toBe("COMPLETED");
    expect(stored.purchaseIntent.status).toBe("COMPLETED");
  });

  it("out-of-order reverse: COMPLETED is not overwritten by a later payment.failed", async () => {
    const { razorpayOrderId, order } = await seedUserAndOrder("PAYMENT_AUTHORIZED");
    const capturedRaw = JSON.stringify(
      paymentCapturedPayload(razorpayOrderId, `pay_ok_${randomUUID().slice(0, 6)}`),
    );
    const captured = await postWebhook(capturedRaw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(capturedRaw),
      [RAZORPAY_EVENT_ID_HEADER]: `evt_phase18_${randomUUID()}`,
    });
    expect(captured.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).state).toBe(
      "COMPLETED",
    );

    const failedRaw = JSON.stringify(
      paymentFailedPayload(razorpayOrderId, `pay_late_${randomUUID().slice(0, 6)}`),
    );
    const failed = await postWebhook(failedRaw, {
      "Content-Type": "application/json",
      [RAZORPAY_SIGNATURE_HEADER]: sign(failedRaw),
      [RAZORPAY_EVENT_ID_HEADER]: `evt_phase18_${randomUUID()}`,
    });
    expect(failed.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).state).toBe(
      "COMPLETED",
    );
  });

  it("returns 200 (ignored) for an unknown Razorpay order id and logs a warning", async () => {
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
    expect(capturedLogText()).toContain("webhook_order_not_found");
  });
});
