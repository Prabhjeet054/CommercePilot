import { describe, expect, it } from "vitest";
import { evaluatePolicy, REASON, type EvaluablePolicy } from "../src/modules/policy/evaluate";

/** Exact demo policy from PRD Sections 32–33. */
const demoPolicy: EvaluablePolicy = {
  autonomousEnabled: true,
  blockedCategories: [],
  allowedCategories: ["Electronics", "Sports", "Travel"],
  dailySpendingLimit: 10_000,
  maxAutonomousTxnsPerDay: 3,
  approvalThreshold: 5_000,
  maxAutonomousAmount: 5_000,
  trustedMerchants: [],
};

const APEX_MERCHANT = "b24bf20e-0000-4000-8000-0000000000aa";
const OTHER_MERCHANT = "c3c43f6c-0000-4000-8000-0000000000bb";

function proposal(overrides: Partial<{ amount: number; category: string; merchantId: string }> = {}) {
  return {
    amount: 4499,
    category: "Sports",
    merchantId: APEX_MERCHANT,
    ...overrides,
  };
}

function policy(overrides: Partial<EvaluablePolicy> = {}): EvaluablePolicy {
  return { ...demoPolicy, ...overrides };
}

describe("evaluatePolicy — branch order (PRD Section 15)", () => {
  it("1. autonomousEnabled=false → REQUIRE_APPROVAL / AUTONOMOUS_DISABLED even for a tiny amount", () => {
    expect(evaluatePolicy(policy({ autonomousEnabled: false }), proposal({ amount: 1 }), 0, 0)).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.AUTONOMOUS_DISABLED,
    });
  });

  it("2. blocked category → DENY / CATEGORY_BLOCKED even when the amount is well within limits", () => {
    const result = evaluatePolicy(
      policy({ blockedCategories: ["Luxury", "Sports"] }),
      proposal({ amount: 100 }),
      0,
      0,
    );
    expect(result).toEqual({ decision: "DENY", reasonCode: REASON.CATEGORY_BLOCKED });
  });

  it("2b. blocked category short-circuits before approval-threshold (still DENY, not REQUIRE_APPROVAL)", () => {
    const result = evaluatePolicy(
      policy({ blockedCategories: ["electronics"], approvalThreshold: 50 }),
      proposal({ amount: 120_000, category: "Electronics" }),
      0,
      0,
    );
    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe(REASON.CATEGORY_BLOCKED);
  });

  it("3. allowedCategories non-empty and category absent → DENY / CATEGORY_NOT_ALLOWED", () => {
    expect(
      evaluatePolicy(policy({ allowedCategories: ["Electronics", "Travel"] }), proposal(), 0, 0),
    ).toEqual({ decision: "DENY", reasonCode: REASON.CATEGORY_NOT_ALLOWED });
  });

  it("3b. allowedCategories=[] means no allow-list restriction (only blockedCategories applies)", () => {
    const open = policy({ allowedCategories: [], blockedCategories: [] });
    expect(evaluatePolicy(open, proposal({ category: "Home" }), 0, 0)).toEqual({
      decision: "ALLOW",
      reasonCode: REASON.WITHIN_POLICY,
    });

    const blockedHome = policy({ allowedCategories: [], blockedCategories: ["Home"] });
    expect(evaluatePolicy(blockedHome, proposal({ category: "Home" }), 0, 0)).toEqual({
      decision: "DENY",
      reasonCode: REASON.CATEGORY_BLOCKED,
    });
  });

  it("4. todaySpend + amount > dailySpendingLimit → REQUIRE_APPROVAL / DAILY_LIMIT_EXCEEDED", () => {
    expect(evaluatePolicy(policy(), proposal({ amount: 100 }), 9_950, 0)).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.DAILY_LIMIT_EXCEEDED,
    });
  });

  it("4b. todaySpend + amount exactly equal to dailySpendingLimit is not exceeded (strict >)", () => {
    expect(evaluatePolicy(policy(), proposal({ amount: 5_000 }), 5_000, 0)).toEqual({
      decision: "ALLOW",
      reasonCode: REASON.WITHIN_POLICY,
    });
  });

  it("5. todayAutonomousCount >= maxAutonomousTxnsPerDay → REQUIRE_APPROVAL even for a tiny amount", () => {
    expect(evaluatePolicy(policy({ maxAutonomousTxnsPerDay: 3 }), proposal({ amount: 1 }), 0, 3)).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.MAX_AUTONOMOUS_TXNS_REACHED,
    });
  });

  it("6. amount strictly above approvalThreshold → REQUIRE_APPROVAL / AMOUNT_ABOVE_APPROVAL_THRESHOLD", () => {
    expect(evaluatePolicy(policy(), proposal({ amount: 5_000.01 }), 0, 0)).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.AMOUNT_ABOVE_APPROVAL_THRESHOLD,
    });
  });

  it("6b. amount exactly equal to approvalThreshold is allowed (strict >, not >=)", () => {
    expect(evaluatePolicy(policy(), proposal({ amount: 5_000 }), 0, 0)).toEqual({
      decision: "ALLOW",
      reasonCode: REASON.WITHIN_POLICY,
    });
  });

  it("6c. amount above approvalThreshold but below maxAutonomousAmount still REQUIRE_APPROVAL (order)", () => {
    const result = evaluatePolicy(
      policy({ approvalThreshold: 5_000, maxAutonomousAmount: 50_000 }),
      proposal({ amount: 6_000 }),
      0,
      0,
    );
    expect(result).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.AMOUNT_ABOVE_APPROVAL_THRESHOLD,
    });
    expect(result.reasonCode).not.toBe(REASON.AMOUNT_ABOVE_MAX_AUTONOMOUS);
    expect(result.reasonCode).not.toBe(REASON.WITHIN_POLICY);
  });

  it("7. amount > maxAutonomousAmount (and <= approvalThreshold) → AMOUNT_ABOVE_MAX_AUTONOMOUS", () => {
    expect(
      evaluatePolicy(
        policy({ approvalThreshold: 10_000, maxAutonomousAmount: 5_000 }),
        proposal({ amount: 6_000 }),
        0,
        0,
      ),
    ).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.AMOUNT_ABOVE_MAX_AUTONOMOUS,
    });
  });

  it("8. trustedMerchants non-empty and merchantId absent → REQUIRE_APPROVAL / MERCHANT_NOT_TRUSTED", () => {
    expect(
      evaluatePolicy(policy({ trustedMerchants: [APEX_MERCHANT] }), proposal({ merchantId: OTHER_MERCHANT }), 0, 0),
    ).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.MERCHANT_NOT_TRUSTED,
    });
  });

  it("8b. merchant on a non-empty trusted list proceeds to ALLOW", () => {
    expect(
      evaluatePolicy(policy({ trustedMerchants: [APEX_MERCHANT] }), proposal({ merchantId: APEX_MERCHANT }), 0, 0),
    ).toEqual({
      decision: "ALLOW",
      reasonCode: REASON.WITHIN_POLICY,
    });
  });

  it("9. otherwise → ALLOW / WITHIN_POLICY", () => {
    expect(evaluatePolicy(policy(), proposal(), 0, 0)).toEqual({
      decision: "ALLOW",
      reasonCode: REASON.WITHIN_POLICY,
    });
  });
});

describe("evaluatePolicy — PRD Section 33 demo scenarios", () => {
  it("₹4,499 running shoe against the demo policy → ALLOW / WITHIN_POLICY", () => {
    expect(evaluatePolicy(demoPolicy, proposal({ amount: 4499, category: "Sports" }), 0, 0)).toEqual({
      decision: "ALLOW",
      reasonCode: REASON.WITHIN_POLICY,
    });
  });

  it("₹1,20,000 laptop against the demo policy → REQUIRE_APPROVAL (daily limit binds first)", () => {
    // Section 15 order is load-bearing: daily_limit (₹10,000) is checked before
    // approval_threshold (₹5,000). ₹1,20,000 exceeds both; the first matching
    // gate wins. Decision is still REQUIRE_APPROVAL (Razorpay must not be called).
    expect(
      evaluatePolicy(demoPolicy, proposal({ amount: 120_000, category: "Electronics" }), 0, 0),
    ).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.DAILY_LIMIT_EXCEEDED,
    });
  });

  it("₹1,20,000 laptop → AMOUNT_ABOVE_APPROVAL_THRESHOLD when the daily limit does not bind", () => {
    expect(
      evaluatePolicy(
        { ...demoPolicy, dailySpendingLimit: 200_000 },
        proposal({ amount: 120_000, category: "Electronics" }),
        0,
        0,
      ),
    ).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.AMOUNT_ABOVE_APPROVAL_THRESHOLD,
    });
  });
});

describe("evaluatePolicy — fail-closed inputs", () => {
  it("rejects a negative amount with DENY / INVALID_AMOUNT (never ALLOW)", () => {
    expect(evaluatePolicy(policy(), proposal({ amount: -1 }), 0, 0)).toEqual({
      decision: "DENY",
      reasonCode: REASON.INVALID_AMOUNT,
    });
  });

  it("rejects a non-finite amount with DENY / INVALID_AMOUNT", () => {
    expect(evaluatePolicy(policy(), proposal({ amount: Number.NaN }), 0, 0)).toEqual({
      decision: "DENY",
      reasonCode: REASON.INVALID_AMOUNT,
    });
    expect(evaluatePolicy(policy(), proposal({ amount: Number.POSITIVE_INFINITY }), 0, 0).reasonCode).toBe(
      REASON.INVALID_AMOUNT,
    );
  });

  it("rejects empty, whitespace, and non-string categories (does not throw, never ALLOW)", () => {
    const open = policy({ allowedCategories: [], blockedCategories: [] });
    expect(evaluatePolicy(open, proposal({ category: "" }), 0, 0)).toEqual({
      decision: "DENY",
      reasonCode: REASON.INVALID_CATEGORY,
    });
    expect(evaluatePolicy(open, proposal({ category: "   " }), 0, 0)).toEqual({
      decision: "DENY",
      reasonCode: REASON.INVALID_CATEGORY,
    });
    expect(
      evaluatePolicy(open, proposal({ category: null as unknown as string }), 0, 0),
    ).toEqual({
      decision: "DENY",
      reasonCode: REASON.INVALID_CATEGORY,
    });
    expect(
      evaluatePolicy(open, proposal({ category: 123 as unknown as string }), 0, 0),
    ).toEqual({
      decision: "DENY",
      reasonCode: REASON.INVALID_CATEGORY,
    });
  });

  it("rejects a missing merchantId without throwing (never ALLOW)", () => {
    const open = policy({ allowedCategories: [], trustedMerchants: [] });
    expect(evaluatePolicy(open, proposal({ merchantId: "" }), 0, 0)).toEqual({
      decision: "DENY",
      reasonCode: REASON.INVALID_MERCHANT,
    });
    expect(
      evaluatePolicy(open, proposal({ merchantId: undefined as unknown as string }), 0, 0),
    ).toEqual({
      decision: "DENY",
      reasonCode: REASON.INVALID_MERCHANT,
    });
  });

  it("treats a non-finite todaySpend as fail-closed REQUIRE_APPROVAL (daily limit), not ALLOW", () => {
    expect(evaluatePolicy(policy(), proposal({ amount: 1 }), Number.NaN, 0)).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.DAILY_LIMIT_EXCEEDED,
    });
  });

  it("treats a negative todaySpend as fail-closed REQUIRE_APPROVAL, not ALLOW", () => {
    expect(evaluatePolicy(policy(), proposal({ amount: 1 }), -1, 0)).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.DAILY_LIMIT_EXCEEDED,
    });
  });

  it("treats a non-finite autonomous count as fail-closed REQUIRE_APPROVAL, not ALLOW", () => {
    expect(evaluatePolicy(policy(), proposal({ amount: 1 }), 0, Number.NaN)).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.MAX_AUTONOMOUS_TXNS_REACHED,
    });
  });

  it("treats a negative autonomous count as fail-closed REQUIRE_APPROVAL, not ALLOW", () => {
    expect(evaluatePolicy(policy(), proposal({ amount: 1 }), 0, -1)).toEqual({
      decision: "REQUIRE_APPROVAL",
      reasonCode: REASON.MAX_AUTONOMOUS_TXNS_REACHED,
    });
  });
});
