import { prisma } from "../../lib/prisma";
import type { OrderState } from "../../lib/state-machine";
import { amountInPaise } from "./create-order";
import { getRazorpayKeyId } from "./razorpay-client";
import {
  RECONCILE_EXHAUSTED_MESSAGE,
  reconcileOrder,
  type ReconcileResult,
} from "./reconcile";

export class RetryNotFoundError extends Error {
  constructor() {
    super("NOT_FOUND");
    this.name = "RetryNotFoundError";
  }
}

export class RetryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryConflictError";
  }
}

export type RetryPaymentResult = {
  orderId: string;
  razorpayOrderId: string;
  amount: number;
  currency: string;
  keyId: string;
  orderState: OrderState;
  reconciliation?: Pick<ReconcileResult, "outcome" | "attemptsThisRun" | "message">;
};

/**
 * Resume an interrupted checkout against the *existing* Razorpay order.
 * Never calls Orders.create — recovery is read/resume only (PRD Section 20).
 *
 * - PAYMENT_PENDING: status-fetch may finalize if Razorpay already captured/failed;
 *   if still pending, return the same razorpay_order_id so Checkout can reopen
 *   (network-drop mid-checkout). Exhaustion must not block resume here.
 * - PAYMENT_AUTHORIZED: waiting on capture confirmation — exhaustion is terminal.
 * - PAYMENT_VERIFICATION_FAILED: never treated as a pending resume (suspicious).
 */
export async function retryPayment(orderId: string, userId: string): Promise<RetryPaymentResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      purchaseIntent: { select: { userId: true } },
    },
  });

  if (!order || order.purchaseIntent.userId !== userId) {
    throw new RetryNotFoundError();
  }

  if (order.state === "PAYMENT_VERIFICATION_FAILED") {
    throw new RetryConflictError("PAYMENT_VERIFICATION_FAILED");
  }

  if (!order.razorpayOrderId) {
    throw new RetryConflictError("NO_RAZORPAY_ORDER");
  }

  let state = order.state as OrderState;
  let reconciliation: RetryPaymentResult["reconciliation"];

  if (state === "PAYMENT_PENDING" || state === "PAYMENT_AUTHORIZED") {
    // User-triggered resume: force past the stuck-timeout so a dropped webhook
    // can still recover via status-fetch within the retry cap.
    const result = await reconcileOrder(order.id, { force: true });
    state = result.orderState;
    reconciliation = {
      outcome: result.outcome,
      attemptsThisRun: result.attemptsThisRun,
      message: result.message,
    };

    // Post-verify (AUTHORIZED): money may have moved — exhaustion is terminal.
    // Pre-pay (PENDING): still allow Checkout resume on the same order id.
    if (result.outcome === "exhausted" && state === "PAYMENT_AUTHORIZED") {
      throw new RetryConflictError("RECONCILE_EXHAUSTED");
    }
  }

  return {
    orderId: order.id,
    razorpayOrderId: order.razorpayOrderId,
    amount: amountInPaise(order.amount.toString()),
    currency: order.currency,
    keyId: getRazorpayKeyId(),
    orderState: state,
    reconciliation,
  };
}

export { RECONCILE_EXHAUSTED_MESSAGE };
