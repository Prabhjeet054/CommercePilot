import { loadEnv } from "../../config/env";
import { prisma } from "../../lib/prisma";
import {
  IllegalTransitionError,
  type OrderState,
} from "../../lib/state-machine";
import { recordAudit, resolveCorrelationId } from "../audit/audit.service";
import { applyOrderLifecycleEvent } from "../orders/order.service";
import {
  getRazorpayClient,
  RazorpayApiError,
  type RazorpayFetchedPayment,
  type RazorpayOrdersClient,
} from "./razorpay-client";

const STUCK_STATES = new Set<OrderState>(["PAYMENT_PENDING", "PAYMENT_AUTHORIZED"]);

const TERMINAL_OK = new Set<OrderState>(["COMPLETED", "PAYMENT_CAPTURED"]);

export const RECONCILE_EXHAUSTED_MESSAGE =
  "Unable to confirm payment automatically, please check your order history";

export type ReconcileOutcome =
  | "noop"
  | "too_early"
  | "completed"
  | "failed"
  | "still_pending"
  | "exhausted"
  | "unchanged";

export type ReconcileResult = {
  orderId: string;
  orderState: OrderState;
  outcome: ReconcileOutcome;
  attemptsThisRun: number;
  priorAttempts: number;
  message?: string;
  razorpayOrderStatus?: string;
};

export type ReconcileOptions = {
  /** Skip the stuck-timeout gate (e.g. user-triggered confirm after soft timeout). */
  force?: boolean;
  client?: RazorpayOrdersClient;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
};

function parseBackoffMs(raw: string): number[] {
  const parts = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parts.length > 0 ? parts : [1000, 4000, 16000];
}

export function getReconcileConfig(source = loadEnv()) {
  return {
    timeoutMs: source.PAYMENT_RECONCILE_TIMEOUT_SECONDS * 1000,
    maxAttempts: source.PAYMENT_RECONCILE_MAX_ATTEMPTS,
    backoffMs: parseBackoffMs(source.PAYMENT_RECONCILE_BACKOFF_MS),
  };
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function countPriorAttempts(purchaseIntentId: string): Promise<number> {
  return prisma.auditLog.count({
    where: {
      purchaseIntentId,
      action: "payment_reconcile_attempt",
    },
  });
}

function classifyPayments(payments: RazorpayFetchedPayment[]): "captured" | "failed" | "pending" {
  if (payments.some((p) => p.status === "captured")) {
    return "captured";
  }
  if (payments.length > 0 && payments.every((p) => p.status === "failed")) {
    return "failed";
  }
  if (payments.some((p) => p.status === "authorized" || p.status === "created")) {
    return "pending";
  }
  return "pending";
}

/**
 * Apply capture confirmation the same way the webhook path does, but tolerate
 * races where a concurrent webhook already advanced the state machine.
 */
export async function applyCapturedStatus(orderId: string, _hint?: OrderState): Promise<OrderState> {
  const fresh = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { state: true },
  });
  let current = fresh.state as OrderState;

  try {
    if (current === "COMPLETED") {
      return current;
    }
    if (current === "PAYMENT_CAPTURED") {
      return await applyOrderLifecycleEvent(orderId, "order_paid_confirmed");
    }
    if (
      current === "ORDER_CREATED" ||
      current === "PAYMENT_PENDING" ||
      current === "PAYMENT_AUTHORIZED" ||
      current === "PAYMENT_FAILED" ||
      current === "PAYMENT_VERIFICATION_FAILED"
    ) {
      await applyOrderLifecycleEvent(orderId, "webhook_captured");
      return await applyOrderLifecycleEvent(orderId, "order_paid_confirmed");
    }
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "capture_ignored_state",
        orderId,
        current,
      }),
    );
    return current;
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) {
      throw err;
    }
    const again = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { state: true },
    });
    const state = again.state as OrderState;
    if (state === "PAYMENT_CAPTURED") {
      try {
        return await applyOrderLifecycleEvent(orderId, "order_paid_confirmed");
      } catch (inner) {
        if (inner instanceof IllegalTransitionError) {
          const finalRow = await prisma.order.findUniqueOrThrow({
            where: { id: orderId },
            select: { state: true },
          });
          return finalRow.state as OrderState;
        }
        throw inner;
      }
    }
    return state;
  }
}

async function applyFailedStatus(orderId: string, current: OrderState): Promise<OrderState> {
  try {
    if (current === "PAYMENT_FAILED" || current === "COMPLETED" || current === "CANCELLED") {
      return current;
    }
    if (current === "PAYMENT_PENDING" || current === "ORDER_CREATED") {
      if (current === "ORDER_CREATED") {
        await applyOrderLifecycleEvent(orderId, "checkout_opened");
      }
      return await applyOrderLifecycleEvent(orderId, "payment_failed_webhook");
    }
    if (current === "PAYMENT_AUTHORIZED") {
      return await applyOrderLifecycleEvent(orderId, "webhook_failed");
    }
    return current;
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) {
      throw err;
    }
    const fresh = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { state: true },
    });
    return fresh.state as OrderState;
  }
}

/**
 * Server-side Razorpay status-fetch fallback for orders stuck in
 * PAYMENT_PENDING / PAYMENT_AUTHORIZED. Never calls Orders.create — read-only
 * recovery with capped retries and audit logging (PRD Section 20).
 */
export async function reconcileOrder(
  orderId: string,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const config = getReconcileConfig();
  const client = options.client ?? getRazorpayClient();
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? new Date();

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      state: true,
      updatedAt: true,
      razorpayOrderId: true,
      purchaseIntentId: true,
    },
  });

  if (!order) {
    throw new ReconcileNotFoundError();
  }

  let state = order.state as OrderState;

  if (state === "COMPLETED") {
    return {
      orderId: order.id,
      orderState: state,
      outcome: "noop",
      attemptsThisRun: 0,
      priorAttempts: await countPriorAttempts(order.purchaseIntentId),
    };
  }

  if (TERMINAL_OK.has(state)) {
    state = await applyCapturedStatus(order.id, state);
    return {
      orderId: order.id,
      orderState: state,
      outcome: state === "COMPLETED" ? "completed" : "unchanged",
      attemptsThisRun: 0,
      priorAttempts: await countPriorAttempts(order.purchaseIntentId),
    };
  }

  if (!STUCK_STATES.has(state)) {
    return {
      orderId: order.id,
      orderState: state,
      outcome: "unchanged",
      attemptsThisRun: 0,
      priorAttempts: await countPriorAttempts(order.purchaseIntentId),
      message: `Order is not in a stuck payment state (${state})`,
    };
  }

  if (!order.razorpayOrderId) {
    return {
      orderId: order.id,
      orderState: state,
      outcome: "unchanged",
      attemptsThisRun: 0,
      priorAttempts: 0,
      message: "Order has no razorpayOrderId to reconcile",
    };
  }

  const ageMs = now.getTime() - order.updatedAt.getTime();
  if (!options.force && ageMs < config.timeoutMs) {
    return {
      orderId: order.id,
      orderState: state,
      outcome: "too_early",
      attemptsThisRun: 0,
      priorAttempts: await countPriorAttempts(order.purchaseIntentId),
      message: `Stuck timeout not reached (${Math.floor(ageMs / 1000)}s < ${config.timeoutMs / 1000}s)`,
    };
  }

  const priorAttempts = await countPriorAttempts(order.purchaseIntentId);
  if (priorAttempts >= config.maxAttempts) {
    // Already capped — do not append another exhausted audit on every no-op call.
    const alreadyExhausted = await prisma.auditLog.count({
      where: { purchaseIntentId: order.purchaseIntentId, action: "payment_reconcile_exhausted" },
    });
    if (alreadyExhausted === 0) {
      await recordExhausted(order.purchaseIntentId, order.id, state, priorAttempts);
    }
    return {
      orderId: order.id,
      orderState: state,
      outcome: "exhausted",
      attemptsThisRun: 0,
      priorAttempts,
      message: RECONCILE_EXHAUSTED_MESSAGE,
    };
  }

  const remaining = config.maxAttempts - priorAttempts;
  let attemptsThisRun = 0;
  let lastOrderStatus: string | undefined;
  const correlationId = await resolveCorrelationId(order.purchaseIntentId);

  for (let i = 0; i < remaining; i += 1) {
    attemptsThisRun += 1;
    const attemptNumber = priorAttempts + attemptsThisRun;

    await recordAudit({
      purchaseIntentId: order.purchaseIntentId,
      actor: "system",
      action: "payment_reconcile_attempt",
      correlationId,
      payload: {
        orderId: order.id,
        attempt: attemptNumber,
        maxAttempts: config.maxAttempts,
        orderState: state,
      },
    });

    try {
      const fetched = await client.fetchOrder(order.razorpayOrderId);
      lastOrderStatus = fetched.status;
      const payments = await client.fetchOrderPayments(order.razorpayOrderId);

      let classification = classifyPayments(payments);
      if (fetched.status === "paid") {
        classification = "captured";
      }

      if (classification === "captured") {
        state = await applyCapturedStatus(order.id, state);
        if (state === "COMPLETED") {
          await recordAudit({
            purchaseIntentId: order.purchaseIntentId,
            actor: "system",
            action: "order_completed",
            correlationId,
            payload: {
              orderId: order.id,
              source: "reconcile",
              razorpayOrderStatus: fetched.status,
            },
          });
        }
        return {
          orderId: order.id,
          orderState: state,
          outcome: "completed",
          attemptsThisRun,
          priorAttempts,
          razorpayOrderStatus: fetched.status,
        };
      }

      if (classification === "failed") {
        state = await applyFailedStatus(order.id, state);
        await recordAudit({
          purchaseIntentId: order.purchaseIntentId,
          actor: "system",
          action: "payment_failed",
          correlationId,
          payload: {
            orderId: order.id,
            source: "reconcile",
            razorpayOrderStatus: fetched.status,
          },
        });
        return {
          orderId: order.id,
          orderState: state,
          outcome: "failed",
          attemptsThisRun,
          priorAttempts,
          razorpayOrderStatus: fetched.status,
        };
      }

      // Still pending at Razorpay — never treat silence as failure.
      const fresh = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { state: true },
      });
      state = fresh.state as OrderState;
      if (state === "COMPLETED") {
        return {
          orderId: order.id,
          orderState: state,
          outcome: "noop",
          attemptsThisRun,
          priorAttempts,
          razorpayOrderStatus: fetched.status,
        };
      }
    } catch (err) {
      // API unreachable / transient — log and retry within the cap; do not crash.
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "payment_reconcile_fetch_failed",
          orderId: order.id,
          attempt: attemptNumber,
          error: err instanceof Error ? err.message : "unknown",
          apiError: err instanceof RazorpayApiError,
        }),
      );
    }

    if (i < remaining - 1) {
      const delay = config.backoffMs[Math.min(i, config.backoffMs.length - 1)] ?? 0;
      await sleep(delay);
    }
  }

  const totalAttempts = priorAttempts + attemptsThisRun;
  if (totalAttempts >= config.maxAttempts) {
    await recordExhausted(order.purchaseIntentId, order.id, state, totalAttempts);
    return {
      orderId: order.id,
      orderState: state,
      outcome: "exhausted",
      attemptsThisRun,
      priorAttempts,
      message: RECONCILE_EXHAUSTED_MESSAGE,
      razorpayOrderStatus: lastOrderStatus,
    };
  }

  return {
    orderId: order.id,
    orderState: state,
    outcome: "still_pending",
    attemptsThisRun,
    priorAttempts,
    razorpayOrderStatus: lastOrderStatus,
  };
}

async function recordExhausted(
  purchaseIntentId: string,
  orderId: string,
  orderState: OrderState,
  attempts: number,
): Promise<void> {
  const correlationId = await resolveCorrelationId(purchaseIntentId);
  await recordAudit({
    purchaseIntentId,
    actor: "system",
    action: "payment_reconcile_exhausted",
    correlationId,
    payload: {
      orderId,
      orderState,
      attempts,
      message: RECONCILE_EXHAUSTED_MESSAGE,
    },
  });
}

export class ReconcileNotFoundError extends Error {
  constructor() {
    super("NOT_FOUND");
    this.name = "ReconcileNotFoundError";
  }
}
