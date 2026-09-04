import { createHmac, timingSafeEqual } from "crypto";

/**
 * Constant-time HMAC-SHA256 verification.
 * Razorpay Checkout signatures are HMAC-SHA256 hex digests of `order_id|payment_id`
 * (official docs). The Node SDK's `validatePaymentVerification` uses the same
 * digest but compares with `===`; we always gate on `timingSafeEqual` here.
 */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (typeof payload !== "string" || typeof signature !== "string" || typeof secret !== "string") {
    return false;
  }
  if (payload.length === 0 || signature.length === 0 || secret.length === 0) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Checkout signed-string format from Razorpay docs: order_id|payment_id */
export function razorpayCheckoutSignedPayload(orderId: string, paymentId: string): string {
  return `${orderId}|${paymentId}`;
}

export function signRazorpayCheckoutPayload(
  orderId: string,
  paymentId: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(razorpayCheckoutSignedPayload(orderId, paymentId))
    .digest("hex");
}
