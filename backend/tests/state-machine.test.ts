import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  ORDER_STATES,
  TERMINAL_STATES,
  isTerminalState,
  transition,
  type OrderEvent,
  type OrderState,
} from "../src/lib/state-machine";

/** PRD Section 19 table, mirrored here so the production lookup cannot grade its own homework. */
const PRD_ROWS: Array<{ from: OrderState; event: OrderEvent; to: OrderState }> = [
  { from: "CREATED", event: "intent_extracted", to: "INTENT_EXTRACTED" },
  { from: "INTENT_EXTRACTED", event: "products_ranked", to: "PRODUCTS_RANKED" },
  { from: "PRODUCTS_RANKED", event: "policy_evaluated_allow", to: "POLICY_ALLOWED" },
  { from: "PRODUCTS_RANKED", event: "policy_evaluated_deny", to: "POLICY_DENIED" },
  { from: "PRODUCTS_RANKED", event: "policy_evaluated_needs_approval", to: "APPROVAL_PENDING" },
  { from: "APPROVAL_PENDING", event: "approved", to: "APPROVED" },
  { from: "APPROVAL_PENDING", event: "rejected", to: "APPROVAL_REJECTED" },
  { from: "APPROVAL_PENDING", event: "expired", to: "EXPIRED" },
  { from: "POLICY_ALLOWED", event: "order_created", to: "ORDER_CREATED" },
  { from: "APPROVED", event: "order_created", to: "ORDER_CREATED" },
  { from: "ORDER_CREATED", event: "checkout_opened", to: "PAYMENT_PENDING" },
  { from: "PAYMENT_PENDING", event: "signature_verified", to: "PAYMENT_AUTHORIZED" },
  { from: "PAYMENT_PENDING", event: "signature_invalid", to: "PAYMENT_VERIFICATION_FAILED" },
  { from: "PAYMENT_PENDING", event: "payment_failed_webhook", to: "PAYMENT_FAILED" },
  { from: "PAYMENT_AUTHORIZED", event: "webhook_captured", to: "PAYMENT_CAPTURED" },
  { from: "PAYMENT_AUTHORIZED", event: "webhook_failed", to: "PAYMENT_FAILED" },
  { from: "PAYMENT_CAPTURED", event: "order_paid_confirmed", to: "COMPLETED" },
];

function illegalEventFor(state: OrderState): OrderEvent {
  return state === "CREATED" ? "approved" : "intent_extracted";
}

describe("transition (PRD Section 19)", () => {
  it.each(PRD_ROWS)("$from + $event → $to", ({ from, event, to }) => {
    expect(transition(from, event)).toBe(to);
  });

  it.each(
    ORDER_STATES.filter((state) => !TERMINAL_STATES.has(state)).map((from) => ({ from })),
  )("$from + user_cancelled → CANCELLED", ({ from }) => {
    expect(transition(from, "user_cancelled")).toBe("CANCELLED");
  });

  it.each(ORDER_STATES.map((from) => ({ from })))(
    "illegal event from $from throws IllegalTransitionError with from and event",
    ({ from }) => {
      const event = illegalEventFor(from);
      try {
        transition(from, event);
        throw new Error(`expected IllegalTransitionError from ${from} + ${event}`);
      } catch (err) {
        expect(err).toBeInstanceOf(IllegalTransitionError);
        const illegal = err as IllegalTransitionError;
        expect(illegal.from).toBe(from);
        expect(illegal.event).toBe(event);
        expect(illegal.message).toContain(from);
        expect(illegal.message).toContain(event);
      }
    },
  );

  it("does not allow user_cancelled from a terminal state", () => {
    for (const from of TERMINAL_STATES) {
      expect(() => transition(from, "user_cancelled")).toThrow(IllegalTransitionError);
    }
  });

  it("cannot jump POLICY_DENIED to COMPLETED (webhook-bypass structural guard)", () => {
    expect(() => transition("POLICY_DENIED", "order_paid_confirmed")).toThrow(IllegalTransitionError);
    expect(() => transition("POLICY_DENIED", "order_created")).toThrow(IllegalTransitionError);
    expect(() => transition("POLICY_DENIED", "webhook_captured")).toThrow(IllegalTransitionError);
  });

  it("repeating a state-changing event after it has already applied is an error, not a no-op", () => {
    expect(transition("CREATED", "intent_extracted")).toBe("INTENT_EXTRACTED");
    expect(() => transition("INTENT_EXTRACTED", "intent_extracted")).toThrow(IllegalTransitionError);

    expect(transition("APPROVAL_PENDING", "approved")).toBe("APPROVED");
    expect(() => transition("APPROVED", "approved")).toThrow(IllegalTransitionError);

    expect(transition("POLICY_ALLOWED", "order_created")).toBe("ORDER_CREATED");
    expect(() => transition("ORDER_CREATED", "order_created")).toThrow(IllegalTransitionError);
  });

  it("marks the documented failure/terminal states as terminal", () => {
    for (const state of [
      "POLICY_DENIED",
      "APPROVAL_REJECTED",
      "EXPIRED",
      "CANCELLED",
      "PAYMENT_FAILED",
      "PAYMENT_VERIFICATION_FAILED",
      "COMPLETED",
    ] satisfies OrderState[]) {
      expect(isTerminalState(state)).toBe(true);
    }
    expect(isTerminalState("POLICY_ALLOWED")).toBe(false);
    expect(isTerminalState("APPROVAL_PENDING")).toBe(false);
  });
});
