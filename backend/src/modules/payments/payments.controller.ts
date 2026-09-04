import type { Request, Response } from "express";
import {
  AmountBelowMinimumError,
  createRazorpayOrderForPurchaseIntent,
  OrderNotPayableError,
  RazorpayApiError,
} from "./create-order";
import { RazorpayConfigError } from "./razorpay-client";
import { createOrderBodySchema, fieldErrors, verifyPaymentBodySchema } from "./payments.schema";

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

/**
 * Phase 16 stub — Phase 17 replaces this with HMAC verification.
 * Accepts the Checkout handler payload and returns a provisional pending state.
 */
export async function verifyPaymentStub(req: Request, res: Response): Promise<void> {
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

  res.status(501).json({
    verified: false,
    status: "VERIFICATION_PENDING",
    orderState: "ORDER_CREATED",
    message: "Payment received. Server verification lands in Phase 17.",
    razorpay_order_id: parsed.data.razorpay_order_id,
    razorpay_payment_id: parsed.data.razorpay_payment_id,
  });
}
