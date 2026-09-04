import {
  razorpayCheckoutSignedPayload,
  verifySignature,
} from "../../lib/hmac";
import { prisma } from "../../lib/prisma";
import { recordAudit, resolveCorrelationId } from "../audit/audit.service";
import { applyOrderLifecycleEvent } from "../orders/order.service";
import { getRazorpayKeySecret, RazorpayConfigError } from "./razorpay-client";

/** Soft cross-check against the official Node SDK helper when resolvable. */
function sdkValidatePaymentVerification(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string,
): boolean | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const utils = require("razorpay/dist/utils/razorpay-utils") as {
      validatePaymentVerification: (
        params: { order_id: string; payment_id: string },
        signature: string,
        secret: string,
      ) => boolean;
    };
    return utils.validatePaymentVerification(
      { order_id: orderId, payment_id: paymentId },
      signature,
      secret,
    );
  } catch {
    return null;
  }
}

export class PaymentVerifyNotFoundError extends Error {
  constructor() {
    super("NOT_FOUND");
    this.name = "PaymentVerifyNotFoundError";
  }
}

export class PaymentSignatureMismatchError extends Error {
  readonly reasonCode = "SIGNATURE_MISMATCH" as const;

  constructor() {
    super("SIGNATURE_MISMATCH");
    this.name = "PaymentSignatureMismatchError";
  }
}

export class PaymentVerifyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentVerifyConflictError";
  }
}

export type VerifyPaymentResult = {
  verified: true;
  orderState: string;
};

/**
 * Prefer the same signed-string the official Node SDK uses
 * (`order_id|payment_id` → HMAC-SHA256 hex), but compare with constant-time
 * equality. The SDK helper uses `===`, which we deliberately do not rely on.
 */
export function verifyRazorpayCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string = getRazorpayKeySecret(),
): boolean {
  const ok = verifySignature(razorpayCheckoutSignedPayload(orderId, paymentId), signature, secret);
  const sdk = sdkValidatePaymentVerification(orderId, paymentId, signature, secret);
  if (sdk !== null && sdk !== ok) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "razorpay_sdk_signature_disagreement",
        constantTimeResult: ok,
        sdkResult: sdk,
      }),
    );
  }
  return ok;
}

async function ensurePaymentPending(orderId: string, currentState: string): Promise<string> {
  if (currentState === "ORDER_CREATED") {
    return applyOrderLifecycleEvent(orderId, "checkout_opened");
  }
  return currentState;
}

/**
 * Server-side Checkout callback verification (Phase 17).
 * On success → Payment row + PAYMENT_AUTHORIZED (provisional).
 * On mismatch → PAYMENT_VERIFICATION_FAILED, no Payment row, SIGNATURE_MISMATCH.
 */
export async function verifyCheckoutPayment(input: {
  userId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): Promise<VerifyPaymentResult> {
  const order = await prisma.order.findUnique({
    where: { razorpayOrderId: input.razorpayOrderId },
    include: {
      purchaseIntent: { select: { userId: true } },
      payments: {
        where: { razorpayPaymentId: input.razorpayPaymentId },
        take: 1,
      },
    },
  });

  if (!order || order.purchaseIntent.userId !== input.userId) {
    throw new PaymentVerifyNotFoundError();
  }

  const existing = order.payments[0];
  if (existing?.signatureVerified) {
    return { verified: true, orderState: order.state };
  }

  if (order.state === "PAYMENT_AUTHORIZED") {
    return { verified: true, orderState: order.state };
  }

  if (order.state === "PAYMENT_VERIFICATION_FAILED") {
    throw new PaymentVerifyConflictError("PAYMENT_VERIFICATION_FAILED");
  }

  if (order.state !== "ORDER_CREATED" && order.state !== "PAYMENT_PENDING") {
    throw new PaymentVerifyConflictError(`ORDER_NOT_VERIFIABLE:${order.state}`);
  }

  let secret: string;
  try {
    secret = getRazorpayKeySecret();
  } catch (err) {
    if (err instanceof RazorpayConfigError) {
      throw err;
    }
    throw err;
  }

  const ok = verifyRazorpayCheckoutSignature(
    input.razorpayOrderId,
    input.razorpayPaymentId,
    input.razorpaySignature,
    secret,
  );

  if (!ok) {
    await ensurePaymentPending(order.id, order.state);
    await applyOrderLifecycleEvent(order.id, "signature_invalid");
    console.error(
      JSON.stringify({
        level: "error",
        event: "payment_verification_failed",
        reasonCode: "SIGNATURE_MISMATCH",
        orderId: order.id,
        razorpayOrderId: input.razorpayOrderId,
        razorpayPaymentId: input.razorpayPaymentId,
        // never log RAZORPAY_KEY_SECRET or the expected digest
      }),
    );
    throw new PaymentSignatureMismatchError();
  }

  await ensurePaymentPending(order.id, order.state);

  try {
    await prisma.payment.create({
      data: {
        orderId: order.id,
        razorpayPaymentId: input.razorpayPaymentId,
        razorpaySignature: input.razorpaySignature,
        status: "AUTHORIZED",
        signatureVerified: true,
        verifiedAt: new Date(),
      },
    });
  } catch (err) {
    // Unique on razorpayPaymentId — concurrent/idempotent retry.
    const raced = await prisma.payment.findUnique({
      where: { razorpayPaymentId: input.razorpayPaymentId },
    });
    if (raced?.signatureVerified && raced.orderId === order.id) {
      const current = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      if (current.state === "PAYMENT_AUTHORIZED") {
        return { verified: true, orderState: current.state };
      }
      if (current.state === "PAYMENT_PENDING" || current.state === "ORDER_CREATED") {
        const next = await applyOrderLifecycleEvent(order.id, "signature_verified");
        return { verified: true, orderState: next };
      }
      return { verified: true, orderState: current.state };
    }
    throw err;
  }

  const next = await applyOrderLifecycleEvent(order.id, "signature_verified");
  const correlationId = await resolveCorrelationId(order.purchaseIntentId);
  await recordAudit({
    purchaseIntentId: order.purchaseIntentId,
    actor: input.userId,
    action: "payment_verified",
    correlationId,
    payload: {
      orderId: order.id,
      razorpayOrderId: input.razorpayOrderId,
      razorpayPaymentId: input.razorpayPaymentId,
      orderState: next,
      // deliberately omit razorpaySignature
    },
  });
  return { verified: true, orderState: next };
}
