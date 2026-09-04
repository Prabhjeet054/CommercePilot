import { Prisma } from "@prisma/client";
import { verifySignature } from "../../lib/hmac";
import { loadEnv } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { recordAudit, resolveCorrelationId } from "../audit/audit.service";
import { applyOrderLifecycleEvent } from "../orders/order.service";
import type { OrderState } from "../../lib/state-machine";

/** Official Razorpay webhook signature header (docs: Validate and Test Webhooks). */
export const RAZORPAY_SIGNATURE_HEADER = "x-razorpay-signature";

/** Official deduplication header — unique per event delivery. */
export const RAZORPAY_EVENT_ID_HEADER = "x-razorpay-event-id";

export class WebhookSignatureError extends Error {
  constructor(message = "INVALID_WEBHOOK_SIGNATURE") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export class WebhookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigError";
  }
}

export type WebhookHandleResult = {
  received: true;
  duplicate?: boolean;
  ignored?: boolean;
  orderState?: string;
};

function getWebhookSecret(): string {
  const secret = loadEnv().RAZORPAY_WEBHOOK_SECRET?.trim() ?? "";
  if (!secret) {
    throw new WebhookConfigError("RAZORPAY_WEBHOOK_SECRET is not configured");
  }
  return secret;
}

/**
 * HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET) with constant-time compare.
 * Must run on the untouched request bytes — never a re-serialized JSON object.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || signatureHeader.length === 0) {
    return false;
  }
  const secret = getWebhookSecret();
  const payload = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  return verifySignature(payload, signatureHeader, secret);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function extractRazorpayOrderId(eventType: string, body: Record<string, unknown>): string | null {
  const payload = asRecord(body.payload);
  if (!payload) {
    return null;
  }

  if (eventType === "order.paid") {
    const order = asRecord(payload.order);
    const entity = order ? asRecord(order.entity) : null;
    if (entity && typeof entity.id === "string") {
      return entity.id;
    }
  }

  const payment = asRecord(payload.payment);
  const entity = payment ? asRecord(payment.entity) : null;
  if (entity && typeof entity.order_id === "string") {
    return entity.order_id;
  }
  return null;
}

async function finalizeCaptured(orderId: string, current: OrderState): Promise<OrderState> {
  if (current === "COMPLETED") {
    return current;
  }
  if (current === "PAYMENT_CAPTURED") {
    return applyOrderLifecycleEvent(orderId, "order_paid_confirmed");
  }
  if (
    current === "ORDER_CREATED" ||
    current === "PAYMENT_PENDING" ||
    current === "PAYMENT_AUTHORIZED" ||
    current === "PAYMENT_FAILED" ||
    current === "PAYMENT_VERIFICATION_FAILED"
  ) {
    await applyOrderLifecycleEvent(orderId, "webhook_captured");
    return applyOrderLifecycleEvent(orderId, "order_paid_confirmed");
  }
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "webhook_capture_ignored_state",
      orderId,
      current,
    }),
  );
  return current;
}

async function applyPaymentFailed(orderId: string, current: OrderState): Promise<OrderState> {
  if (current === "PAYMENT_FAILED" || current === "COMPLETED" || current === "CANCELLED") {
    return current;
  }
  if (current === "PAYMENT_PENDING" || current === "ORDER_CREATED") {
    if (current === "ORDER_CREATED") {
      await applyOrderLifecycleEvent(orderId, "checkout_opened");
    }
    return applyOrderLifecycleEvent(orderId, "payment_failed_webhook");
  }
  if (current === "PAYMENT_AUTHORIZED") {
    return applyOrderLifecycleEvent(orderId, "webhook_failed");
  }
  return current;
}

async function applyPaymentAuthorized(orderId: string, current: OrderState): Promise<OrderState> {
  if (
    current === "PAYMENT_AUTHORIZED" ||
    current === "PAYMENT_CAPTURED" ||
    current === "COMPLETED"
  ) {
    return current;
  }
  if (current === "ORDER_CREATED") {
    await applyOrderLifecycleEvent(orderId, "checkout_opened");
    return applyOrderLifecycleEvent(orderId, "signature_verified");
  }
  if (current === "PAYMENT_PENDING") {
    return applyOrderLifecycleEvent(orderId, "signature_verified");
  }
  return current;
}

/**
 * Process a verified Razorpay webhook. Caller must already have validated the signature
 * against the raw body and extracted `x-razorpay-event-id`.
 */
export async function handleRazorpayWebhook(input: {
  rawBody: Buffer;
  eventId: string;
  signatureValid: true;
}): Promise<WebhookHandleResult> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(input.rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    // Signature already matched — return 200 so Razorpay does not retry forever on garbage.
    console.warn(JSON.stringify({ level: "warn", event: "webhook_json_parse_failed", eventId: input.eventId }));
    return { received: true, ignored: true };
  }

  const eventType = typeof body.event === "string" ? body.event : "unknown";
  const razorpayOrderId = extractRazorpayOrderId(eventType, body);

  const existing = await prisma.webhookEvent.findUnique({ where: { eventId: input.eventId } });
  if (existing) {
    return { received: true, duplicate: true };
  }

  let order =
    razorpayOrderId !== null
      ? await prisma.order.findUnique({ where: { razorpayOrderId } })
      : null;

  try {
    await prisma.webhookEvent.create({
      data: {
        eventId: input.eventId,
        eventType,
        orderId: order?.id ?? null,
        rawPayload: body as Prisma.InputJsonValue,
        signatureValid: true,
      },
    });
  } catch (err) {
    // Unique eventId race — treat as duplicate.
    const raced = await prisma.webhookEvent.findUnique({ where: { eventId: input.eventId } });
    if (raced) {
      return { received: true, duplicate: true };
    }
    throw err;
  }

  if (!order) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "webhook_order_not_found",
        eventId: input.eventId,
        eventType,
        razorpayOrderId,
      }),
    );
    await prisma.webhookEvent.update({
      where: { eventId: input.eventId },
      data: { processedAt: new Date() },
    });
    return { received: true, ignored: true };
  }

  let nextState = order.state as OrderState;
  if (eventType === "payment.captured" || eventType === "order.paid") {
    nextState = await finalizeCaptured(order.id, nextState);
  } else if (eventType === "payment.failed") {
    nextState = await applyPaymentFailed(order.id, nextState);
  } else if (eventType === "payment.authorized") {
    nextState = await applyPaymentAuthorized(order.id, nextState);
  }

  const correlationId = await resolveCorrelationId(order.purchaseIntentId);
  await recordAudit({
    purchaseIntentId: order.purchaseIntentId,
    actor: "razorpay_webhook",
    action: "webhook_received",
    correlationId,
    payload: {
      eventId: input.eventId,
      eventType,
      razorpayOrderId,
      orderState: nextState,
    },
  });

  if (nextState === "COMPLETED") {
    await recordAudit({
      purchaseIntentId: order.purchaseIntentId,
      actor: "razorpay_webhook",
      action: "order_completed",
      correlationId,
      payload: {
        orderId: order.id,
        eventType,
      },
    });
  }

  if (nextState === "PAYMENT_FAILED") {
    await recordAudit({
      purchaseIntentId: order.purchaseIntentId,
      actor: "razorpay_webhook",
      action: "payment_failed",
      correlationId,
      payload: {
        orderId: order.id,
        eventType,
      },
    });
  }

  await prisma.webhookEvent.update({
    where: { eventId: input.eventId },
    data: { processedAt: new Date(), orderId: order.id },
  });

  return { received: true, orderState: nextState };
}
