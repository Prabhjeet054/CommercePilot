/**
 * Deterministic financial policy engine (PRD Section 15).
 *
 * Pure, network-free, LLM-free. Branch order is a documented safety property:
 * hard DENY checks short-circuit before soft REQUIRE_APPROVAL thresholds.
 * Do not reorder these branches.
 */

export type PolicyDecision = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

export type PurchaseProposal = {
  amount: number;
  category: string;
  merchantId: string;
};

/**
 * Structural subset of Prisma `FinancialPolicy` using the exact schema field
 * names. Money fields accept number, numeric string, or Prisma Decimal.
 */
export type EvaluablePolicy = {
  autonomousEnabled: boolean;
  blockedCategories: string[];
  allowedCategories: string[];
  dailySpendingLimit: { toString(): string } | number | string;
  maxAutonomousTxnsPerDay: number;
  approvalThreshold: { toString(): string } | number | string;
  maxAutonomousAmount: { toString(): string } | number | string;
  trustedMerchants: string[];
};

export type PolicyResult = {
  decision: PolicyDecision;
  reasonCode: string;
};

export const REASON = {
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_CATEGORY: "INVALID_CATEGORY",
  INVALID_MERCHANT: "INVALID_MERCHANT",
  AUTONOMOUS_DISABLED: "AUTONOMOUS_DISABLED",
  CATEGORY_BLOCKED: "CATEGORY_BLOCKED",
  CATEGORY_NOT_ALLOWED: "CATEGORY_NOT_ALLOWED",
  DAILY_LIMIT_EXCEEDED: "DAILY_LIMIT_EXCEEDED",
  MAX_AUTONOMOUS_TXNS_REACHED: "MAX_AUTONOMOUS_TXNS_REACHED",
  AMOUNT_ABOVE_APPROVAL_THRESHOLD: "AMOUNT_ABOVE_APPROVAL_THRESHOLD",
  AMOUNT_ABOVE_MAX_AUTONOMOUS: "AMOUNT_ABOVE_MAX_AUTONOMOUS",
  MERCHANT_NOT_TRUSTED: "MERCHANT_NOT_TRUSTED",
  WITHIN_POLICY: "WITHIN_POLICY",
  NO_POLICY_CONFIGURED: "NO_POLICY_CONFIGURED",
} as const;

function rupees(value: { toString(): string } | number | string): number {
  return Number(Number(value.toString()).toFixed(2));
}

function normalizeCategory(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function categorySet(values: string[]): Set<string> {
  return new Set(values.map(normalizeCategory).filter((value) => value.length > 0));
}

function merchantSet(values: string[]): Set<string> {
  return new Set(
    values
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0),
  );
}

function finiteOrInfinity(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

export function evaluatePolicy(
  policy: EvaluablePolicy,
  proposal: PurchaseProposal,
  todaySpend: number,
  todayAutonomousCount: number,
): PolicyResult {
  if (!Number.isFinite(proposal.amount) || proposal.amount < 0) {
    return { decision: "DENY", reasonCode: REASON.INVALID_AMOUNT };
  }

  const category = normalizeCategory(proposal.category);
  if (category.length === 0) {
    return { decision: "DENY", reasonCode: REASON.INVALID_CATEGORY };
  }

  const merchantId =
    typeof proposal.merchantId === "string" ? proposal.merchantId.trim().toLowerCase() : "";
  if (merchantId.length === 0) {
    return { decision: "DENY", reasonCode: REASON.INVALID_MERCHANT };
  }

  const amount = rupees(proposal.amount);
  const spend = finiteOrInfinity(todaySpend);
  const autonomousCount = finiteOrInfinity(todayAutonomousCount);

  // 1. Autonomous purchasing disabled — soft gate, even for a tiny amount.
  if (!policy.autonomousEnabled) {
    return { decision: "REQUIRE_APPROVAL", reasonCode: REASON.AUTONOMOUS_DISABLED };
  }

  // 2. Hard DENY: category is on the block list.
  if (categorySet(policy.blockedCategories).has(category)) {
    return { decision: "DENY", reasonCode: REASON.CATEGORY_BLOCKED };
  }

  // 3. Hard DENY: allow-list is non-empty and category is absent.
  //    Empty allow-list means "no allow-list restriction".
  if (
    policy.allowedCategories.length > 0 &&
    !categorySet(policy.allowedCategories).has(category)
  ) {
    return { decision: "DENY", reasonCode: REASON.CATEGORY_NOT_ALLOWED };
  }

  // 4. Soft: today's completed spend plus this proposal exceeds the daily cap.
  if (spend + amount > rupees(policy.dailySpendingLimit)) {
    return { decision: "REQUIRE_APPROVAL", reasonCode: REASON.DAILY_LIMIT_EXCEEDED };
  }

  // 5. Soft: autonomous txn quota for the day is already exhausted (>=).
  if (autonomousCount >= policy.maxAutonomousTxnsPerDay) {
    return { decision: "REQUIRE_APPROVAL", reasonCode: REASON.MAX_AUTONOMOUS_TXNS_REACHED };
  }

  // 6. Soft: amount strictly above approval threshold.
  if (amount > rupees(policy.approvalThreshold)) {
    return { decision: "REQUIRE_APPROVAL", reasonCode: REASON.AMOUNT_ABOVE_APPROVAL_THRESHOLD };
  }

  // 7. Soft: amount strictly above max autonomous amount.
  if (amount > rupees(policy.maxAutonomousAmount)) {
    return { decision: "REQUIRE_APPROVAL", reasonCode: REASON.AMOUNT_ABOVE_MAX_AUTONOMOUS };
  }

  // 8. Soft: trusted-merchant list is non-empty and this merchant is absent.
  if (
    policy.trustedMerchants.length > 0 &&
    !merchantSet(policy.trustedMerchants).has(merchantId)
  ) {
    return { decision: "REQUIRE_APPROVAL", reasonCode: REASON.MERCHANT_NOT_TRUSTED };
  }

  // 9. All gates passed.
  return { decision: "ALLOW", reasonCode: REASON.WITHIN_POLICY };
}
