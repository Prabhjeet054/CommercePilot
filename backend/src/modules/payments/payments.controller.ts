import type { Request, Response } from "express";
import {
  AmountBelowMinimumError,
  createRazorpayOrderForPurchaseIntent,
  OrderNotPayableError,
  RazorpayApiError,
} from "./create-order";
import { RazorpayConfigError } from "./razorpay-client";
import { createOrderBodySchema, fieldErrors, verifyPaymentBodySchema } from "./payments.schema";
import {
  PaymentSignatureMismatchError,
  PaymentVerifyConflictError,
  PaymentVerifyNotFoundError,
  verifyCheckoutPayment,
} from "./verify";
import {
  RECONCILE_EXHAUSTED_MESSAGE,
  RetryConflictError,
  RetryNotFoundError,
  retryPayment as retryPaymentService,
} from "./retry";

export async function createOrder(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const parsed = createOrderBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", fields: fieldErrors(parsed.error) });
    return;
  }

  try {
    const result = await createRazorpayOrderForPurchaseIntent(parsed.data.purchaseIntentId, userId);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof AmountBelowMinimumError) {
      res.status(400).json({ error: "AMOUNT_BELOW_MINIMUM", amountInPaise: err.amountInPaise });
      return;
    }
    if (err instanceof RazorpayConfigError || err instanceof RazorpayApiError) {
      res.status(400).json({ error: "RAZORPAY_ERROR" });
      return;
    }
    if (err instanceof OrderNotPayableError) {
      if (err.message === "NOT_FOUND") {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
}

export async function verifyPayment(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const parsed = verifyPaymentBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", fields: fieldErrors(parsed.error) });
    return;
  }

  try {
    const result = await verifyCheckoutPayment({
      userId,
      razorpayOrderId: parsed.data.razorpay_order_id,
      razorpayPaymentId: parsed.data.razorpay_payment_id,
      razorpaySignature: parsed.data.razorpay_signature,
    });
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof PaymentVerifyNotFoundError) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    if (err instanceof PaymentSignatureMismatchError) {
      res.status(409).json({
        error: "SIGNATURE_MISMATCH",
        reasonCode: "SIGNATURE_MISMATCH",
        verified: false,
        orderState: "PAYMENT_VERIFICATION_FAILED",
        message: "Payment signature could not be verified.",
      });
      return;
    }
    if (err instanceof PaymentVerifyConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof RazorpayConfigError) {
      res.status(503).json({
        error: "RAZORPAY_NOT_CONFIGURED",
        message: "Razorpay is not configured for signature verification.",
      });
      return;
    }
    throw err;
  }
}

export async function retryPayment(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const orderId = typeof req.params.orderId === "string" ? req.params.orderId : "";
  if (!orderId) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "orderId is required" });
    return;
  }

  try {
    const result = await retryPaymentService(orderId, userId);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof RetryNotFoundError) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    if (err instanceof RetryConflictError) {
      if (err.message === "RECONCILE_EXHAUSTED") {
        res.status(409).json({
          error: "RECONCILE_EXHAUSTED",
          message: RECONCILE_EXHAUSTED_MESSAGE,
        });
        return;
      }
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
}
