import { Prisma } from "@prisma/client";
import {
  applyPurchaseIntentEvent,
  transition,
  type OrderEvent,
  type OrderState,
} from "../../lib/state-machine";
import { prisma } from "../../lib/prisma";
import { recordAudit, resolveCorrelationId } from "../audit/audit.service";

export type CreateInternalOrderInput = {
  purchaseIntentId: string;
  productId: string;
  amount: number;
  currency?: string;
  razorpayOrderId?: string | null;
};

export type InternalOrder = {
  id: string;
  purchaseIntentId: string;
  productId: string;
  amount: string;
  currency: string;
  state: OrderState;
  razorpayOrderId: string | null;
};

function serializeOrder(row: {
  id: string;
  purchaseIntentId: string;
  productId: string;
  amount: Prisma.Decimal;
  currency: string;
  state: string;
  razorpayOrderId: string | null;
}): InternalOrder {
  return {
    id: row.id,
    purchaseIntentId: row.purchaseIntentId,
    productId: row.productId,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    state: row.state as OrderState,
    razorpayOrderId: row.razorpayOrderId,
  };
}

/**
 * Creates the internal Order row and moves the purchase intent
 * POLICY_ALLOWED | APPROVED → ORDER_CREATED through the state machine.
 * Phase 15 passes `razorpayOrderId` only after a successful Orders API call
 * so a Razorpay failure never advances this state.
 */
export async function createInternalOrder(input: CreateInternalOrderInput): Promise<InternalOrder> {
  const intent = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: input.purchaseIntentId },
    select: { id: true, status: true },
  });

  const nextIntentState = transition(intent.status as OrderState, "order_created");

  const order = await prisma.$transaction(async (tx) => {
    await applyPurchaseIntentEvent(input.purchaseIntentId, "order_created", tx);
    return tx.order.create({
      data: {
        purchaseIntentId: input.purchaseIntentId,
        productId: input.productId,
        amount: new Prisma.Decimal(input.amount.toFixed(2)),
        currency: input.currency ?? "INR",
        state: nextIntentState,
        razorpayOrderId: input.razorpayOrderId ?? null,
      },
    });
  });

  const correlationId = await resolveCorrelationId(input.purchaseIntentId);
  await recordAudit({
    purchaseIntentId: input.purchaseIntentId,
    actor: "system",
    action: "order_created",
    correlationId,
    payload: {
      orderId: order.id,
      amount: order.amount.toFixed(2),
      currency: order.currency,
      razorpayOrderId: order.razorpayOrderId,
    },
  });

  return serializeOrder(order);
}

/**
 * Applies a lifecycle event to both `orders.state` and `purchase_intents.status`.
 * This is the only place outside createInternalOrder that may write `orders.state`.
 */
export async function applyOrderLifecycleEvent(
  orderId: string,
  event: OrderEvent,
): Promise<OrderState> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, purchaseIntentId: true, state: true },
    });
    // Keep intent + order aligned: intent status is the state-machine source of truth.
    const next = await applyPurchaseIntentEvent(order.purchaseIntentId, event, tx);
    if (order.state !== next) {
      await tx.order.update({ where: { id: orderId }, data: { state: next } });
    }
    return next;
  });
}
