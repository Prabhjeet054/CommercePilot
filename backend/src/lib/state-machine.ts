import { prisma } from "./prisma";

type IntentWriter = {
  purchaseIntent: Pick<typeof prisma.purchaseIntent, "findUniqueOrThrow" | "update">;
};

/**
 * Purchase-intent / order lifecycle states from PRD Section 19.
 * `POLICY_PENDING` is a legal stored state (CHECK constraint + narrative chain)
 * but has no inbound row in the Section 19 event table; it only leaves via
 * `user_cancelled` until a later phase introduces an explicit enter event.
 */
export const ORDER_STATES = [
  "CREATED",
  "INTENT_EXTRACTED",
  "PRODUCTS_RANKED",
  "POLICY_PENDING",
  "POLICY_DENIED",
  "APPROVAL_PENDING",
  "POLICY_ALLOWED",
  "APPROVAL_REJECTED",
  "APPROVED",
  "ORDER_CREATED",
  "PAYMENT_PENDING",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_CAPTURED",
  "COMPLETED",
  "PAYMENT_FAILED",
  "PAYMENT_VERIFICATION_FAILED",
  "EXPIRED",
  "CANCELLED",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export const ORDER_EVENTS = [
  "intent_extracted",
  "products_ranked",
  "policy_evaluated_allow",
  "policy_evaluated_deny",
  "policy_evaluated_needs_approval",
  "approved",
  "rejected",
  "expired",
  "order_created",
  "checkout_opened",
  "signature_verified",
  "signature_invalid",
  "payment_failed_webhook",
  "webhook_captured",
  "webhook_failed",
  "order_paid_confirmed",
  "user_cancelled",
] as const;

export type OrderEvent = (typeof ORDER_EVENTS)[number];

export const INITIAL_INTENT_STATE: OrderState = "CREATED";

export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set([
  "POLICY_DENIED",
  "APPROVAL_REJECTED",
  "EXPIRED",
  "CANCELLED",
  "PAYMENT_FAILED",
  "PAYMENT_VERIFICATION_FAILED",
  "COMPLETED",
]);

const DIRECT_TRANSITIONS: ReadonlyArray<readonly [OrderState, OrderEvent, OrderState]> = [
  ["CREATED", "intent_extracted", "INTENT_EXTRACTED"],
  ["INTENT_EXTRACTED", "products_ranked", "PRODUCTS_RANKED"],
  ["PRODUCTS_RANKED", "policy_evaluated_allow", "POLICY_ALLOWED"],
  ["PRODUCTS_RANKED", "policy_evaluated_deny", "POLICY_DENIED"],
  ["PRODUCTS_RANKED", "policy_evaluated_needs_approval", "APPROVAL_PENDING"],
  ["APPROVAL_PENDING", "approved", "APPROVED"],
  ["APPROVAL_PENDING", "rejected", "APPROVAL_REJECTED"],
  ["APPROVAL_PENDING", "expired", "EXPIRED"],
  ["POLICY_ALLOWED", "order_created", "ORDER_CREATED"],
  ["APPROVED", "order_created", "ORDER_CREATED"],
  ["ORDER_CREATED", "checkout_opened", "PAYMENT_PENDING"],
  ["PAYMENT_PENDING", "signature_verified", "PAYMENT_AUTHORIZED"],
  ["PAYMENT_PENDING", "signature_invalid", "PAYMENT_VERIFICATION_FAILED"],
  ["PAYMENT_PENDING", "payment_failed_webhook", "PAYMENT_FAILED"],
  // Phase 18: webhook is authoritative even if Phase 17 verify never ran.
  ["ORDER_CREATED", "webhook_captured", "PAYMENT_CAPTURED"],
  ["PAYMENT_PENDING", "webhook_captured", "PAYMENT_CAPTURED"],
  ["PAYMENT_AUTHORIZED", "webhook_captured", "PAYMENT_CAPTURED"],
  ["PAYMENT_AUTHORIZED", "webhook_failed", "PAYMENT_FAILED"],
  ["PAYMENT_CAPTURED", "order_paid_confirmed", "COMPLETED"],
];

const LOOKUP = new Map<string, OrderState>();
for (const [from, event, to] of DIRECT_TRANSITIONS) {
  LOOKUP.set(key(from, event), to);
}
for (const from of ORDER_STATES) {
  if (!TERMINAL_STATES.has(from)) {
    LOOKUP.set(key(from, "user_cancelled"), "CANCELLED");
  }
}

function key(from: string, event: string): string {
  return `${from}::${event}`;
}

export function isOrderState(value: string): value is OrderState {
  return (ORDER_STATES as readonly string[]).includes(value);
}

export function isTerminalState(state: OrderState): boolean {
  return TERMINAL_STATES.has(state);
}

export class IllegalTransitionError extends Error {
  readonly from: string;
  readonly event: string;

  constructor(from: string, event: string) {
    super(`IllegalTransitionError: cannot apply event "${event}" from state "${from}"`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.event = event;
  }
}

/**
 * Table-driven legal transition (PRD Section 19).
 *
 * Idempotent-repeat decision: **error**. Every event in this table is
 * state-changing. Re-applying the same event after it has already moved the
 * row (e.g. `transition("INTENT_EXTRACTED", "intent_extracted")`) is not in
 * the table and throws. Callers that need retry safety (webhooks, order
 * create) must inspect current state and skip `transition()` when already at
 * the destination. `transition()` itself has no hidden no-op path.
 */
export function transition(currentState: OrderState, event: OrderEvent): OrderState {
  const next = LOOKUP.get(key(currentState, event));
  if (!next) {
    const err = new IllegalTransitionError(currentState, event);
    console.error(err.message);
    throw err;
  }
  return next;
}

function asState(status: string): OrderState {
  if (!isOrderState(status)) {
    const err = new IllegalTransitionError(status, "unknown");
    console.error(err.message);
    throw err;
  }
  return status;
}

/**
 * The only allowed writer of `purchase_intents.status` in application code.
 * Computes the next state via `transition()`, then persists it.
 */
export async function applyPurchaseIntentEvent(
  purchaseIntentId: string,
  event: OrderEvent,
  db: IntentWriter = prisma,
): Promise<OrderState> {
  const row = await db.purchaseIntent.findUniqueOrThrow({
    where: { id: purchaseIntentId },
    select: { status: true },
  });
  const next = transition(asState(row.status), event);
  if (next === row.status) {
    return next;
  }
  await db.purchaseIntent.update({
    where: { id: purchaseIntentId },
    data: { status: next },
  });
  return next;
}

export function policyEventForDecision(
  decision: string,
): Extract<
  OrderEvent,
  "policy_evaluated_allow" | "policy_evaluated_deny" | "policy_evaluated_needs_approval"
> {
  if (decision === "ALLOW") {
    return "policy_evaluated_allow";
  }
  if (decision === "REQUIRE_APPROVAL") {
    return "policy_evaluated_needs_approval";
  }
  return "policy_evaluated_deny";
}
