import { prisma } from "../../lib/prisma";
import { createInternalOrder, type InternalOrder } from "../orders/order.service";
import {
  getRazorpayClient,
  getRazorpayKeyId,
  MIN_ORDER_AMOUNT_PAISE,
  RazorpayApiError,
  type RazorpayOrdersClient,
} from "./razorpay-client";

const PAYABLE_INTENT_STATES = new Set(["POLICY_ALLOWED", "APPROVED", "ORDER_CREATED"]);

export class AmountBelowMinimumError extends Error {
  readonly amountInPaise: number;

  constructor(amountInPaise: number) {
    super(`Amount ${amountInPaise} paise is below Razorpay's INR minimum of ${MIN_ORDER_AMOUNT_PAISE}`);
    this.name = "AmountBelowMinimumError";
    this.amountInPaise = amountInPaise;
  }
}

export class OrderNotPayableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderNotPayableError";
  }
}

export type CreateOrderResult = {
  razorpayOrderId: string;
  amount: number;
  currency: string;
  keyId: string;
};

export function amountInPaise(rupees: number | string): number {
  return Math.round(Number(rupees) * 100);
}

function toCreateOrderResult(order: InternalOrder, razorpayOrderId: string): CreateOrderResult {
  return {
    razorpayOrderId,
    amount: amountInPaise(order.amount),
    currency: order.currency,
    keyId: getRazorpayKeyId(),
  };
}

function assertMinAmount(paise: number): void {
  if (!Number.isInteger(paise) || paise < MIN_ORDER_AMOUNT_PAISE) {
    throw new AmountBelowMinimumError(paise);
  }
}

/**
 * The one rupee→paise conversion boundary. Idempotent: a stored
 * `razorpayOrderId` is returned without calling Razorpay again.
 */
export async function createRazorpayOrder(
  orderId: string,
  client: RazorpayOrdersClient = getRazorpayClient(),
): Promise<CreateOrderResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { purchaseIntent: { select: { id: true, purchaseMode: true, status: true } } },
  });
  if (!order) {
    throw new OrderNotPayableError("Order not found");
  }

  if (order.razorpayOrderId) {
    return toCreateOrderResult(
      {
        id: order.id,
        purchaseIntentId: order.purchaseIntentId,
        productId: order.productId,
        amount: order.amount.toFixed(2),
        currency: order.currency,
        state: order.state as InternalOrder["state"],
        razorpayOrderId: order.razorpayOrderId,
      },
      order.razorpayOrderId,
    );
  }

  const paise = amountInPaise(order.amount.toString());
  assertMinAmount(paise);

  const created = await client.createOrder({
    amount: paise,
    currency: order.currency,
    receipt: order.purchaseIntentId,
    notes: {
      source: "commercepilot_agent",
      purchase_intent_id: order.purchaseIntentId,
      autonomous: String(order.purchaseIntent.purchaseMode === "autonomous"),
    },
  });

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { razorpayOrderId: created.id },
  });

  return toCreateOrderResult(
    {
      id: updated.id,
      purchaseIntentId: updated.purchaseIntentId,
      productId: updated.productId,
      amount: updated.amount.toFixed(2),
      currency: updated.currency,
      state: updated.state as InternalOrder["state"],
      razorpayOrderId: updated.razorpayOrderId,
    },
    created.id,
  );
}

export async function createRazorpayOrderForPurchaseIntent(
  purchaseIntentId: string,
  userId: string,
  client: RazorpayOrdersClient = getRazorpayClient(),
): Promise<CreateOrderResult> {
  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: purchaseIntentId },
    include: {
      order: true,
      agentRun: {
        include: {
          decisions: {
            where: { selected: true },
            include: { product: { select: { id: true, price: true } } },
          },
        },
      },
    },
  });

  if (!intent || intent.userId !== userId) {
    throw new OrderNotPayableError("NOT_FOUND");
  }

  if (!PAYABLE_INTENT_STATES.has(intent.status)) {
    throw new OrderNotPayableError("NOT_PAYABLE");
  }

  if (intent.order) {
    return createRazorpayOrder(intent.order.id, client);
  }

  const selected = intent.agentRun?.decisions.find((row) => row.selected);
  if (!selected) {
    throw new OrderNotPayableError("NO_SELECTED_PRODUCT");
  }

  const rupees = Number(selected.product.price.toString());
  const paise = amountInPaise(rupees);
  assertMinAmount(paise);

  let created;
  try {
    created = await client.createOrder({
      amount: paise,
      currency: "INR",
      receipt: intent.id,
      notes: {
        source: "commercepilot_agent",
        purchase_intent_id: intent.id,
        autonomous: String(intent.purchaseMode === "autonomous"),
      },
    });
  } catch (err) {
    if (err instanceof RazorpayApiError) {
      throw err;
    }
    throw new RazorpayApiError("Razorpay Orders API failed", { cause: err });
  }

  const internal = await createInternalOrder({
    purchaseIntentId: intent.id,
    productId: selected.product.id,
    amount: rupees,
    razorpayOrderId: created.id,
  });

  if (!internal.razorpayOrderId) {
    throw new RazorpayApiError("Internal order persisted without razorpayOrderId");
  }

  return toCreateOrderResult(internal, internal.razorpayOrderId);
}

export { RazorpayApiError };
