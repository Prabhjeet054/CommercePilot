import { Prisma } from "@prisma/client";
import { applyPurchaseIntentEvent, transition, type OrderState } from "../../lib/state-machine";
import { prisma } from "../../lib/prisma";

export type CreateInternalOrderInput = {
  purchaseIntentId: string;
  productId: string;
  amount: number;
  currency?: string;
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
 * Creates the internal Order row (no Razorpay id — Phase 15) and moves the
 * purchase intent POLICY_ALLOWED | APPROVED → ORDER_CREATED through the
 * state machine. Not invoked by the pre-payment pipeline; Phase 15 will call
 * this once checkout is allowed to start.
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
      },
    });
  });

  return serializeOrder(order);
}
