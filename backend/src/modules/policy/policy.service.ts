import { Prisma, type FinancialPolicy, type PolicyEvaluation } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  evaluatePolicy,
  REASON,
  type PolicyDecision,
  type PolicyResult,
  type PurchaseProposal,
} from "./evaluate";

const COMPLETED_ORDER_STATE = "COMPLETED";
const AUTONOMOUS_MODE = "autonomous";

export type PolicySnapshot = {
  configured: boolean;
  id: string | null;
  userId: string;
  maxAutonomousAmount: string | null;
  dailySpendingLimit: string | null;
  approvalThreshold: string | null;
  allowedCategories: string[];
  blockedCategories: string[];
  trustedMerchants: string[];
  autonomousEnabled: boolean | null;
  maxAutonomousTxnsPerDay: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type EvaluateAndPersistInput = {
  userId: string;
  purchaseIntentId: string;
  proposal: PurchaseProposal;
  now?: Date;
};

export type EvaluateAndPersistResult = PolicyResult & {
  evaluation: PolicyEvaluation;
  todaySpend: number;
  todayAutonomousCount: number;
  policySnapshot: PolicySnapshot;
};

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function endOfUtcDay(now: Date): Date {
  const start = startOfUtcDay(now);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function snapshotPolicy(userId: string, policy: FinancialPolicy | null): PolicySnapshot {
  if (!policy) {
    return {
      configured: false,
      id: null,
      userId,
      maxAutonomousAmount: null,
      dailySpendingLimit: null,
      approvalThreshold: null,
      allowedCategories: [],
      blockedCategories: [],
      trustedMerchants: [],
      autonomousEnabled: null,
      maxAutonomousTxnsPerDay: null,
      createdAt: null,
      updatedAt: null,
    };
  }

  return {
    configured: true,
    id: policy.id,
    userId: policy.userId,
    maxAutonomousAmount: policy.maxAutonomousAmount.toFixed(2),
    dailySpendingLimit: policy.dailySpendingLimit.toFixed(2),
    approvalThreshold: policy.approvalThreshold.toFixed(2),
    allowedCategories: [...policy.allowedCategories],
    blockedCategories: [...policy.blockedCategories],
    trustedMerchants: [...policy.trustedMerchants],
    autonomousEnabled: policy.autonomousEnabled,
    maxAutonomousTxnsPerDay: policy.maxAutonomousTxnsPerDay,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

export async function computeTodaySpend(userId: string, now: Date = new Date()): Promise<{
  todaySpend: number;
  todayAutonomousCount: number;
}> {
  const orders = await prisma.order.findMany({
    where: {
      state: COMPLETED_ORDER_STATE,
      createdAt: { gte: startOfUtcDay(now), lt: endOfUtcDay(now) },
      purchaseIntent: { userId },
    },
    select: {
      amount: true,
      purchaseIntent: { select: { purchaseMode: true } },
    },
  });

  const todaySpend = orders.reduce(
    (sum, order) => sum + Number(order.amount.toFixed(2)),
    0,
  );
  const todayAutonomousCount = orders.filter(
    (order) => order.purchaseIntent.purchaseMode === AUTONOMOUS_MODE,
  ).length;

  return { todaySpend: Number(todaySpend.toFixed(2)), todayAutonomousCount };
}

export async function evaluateAndPersist(
  input: EvaluateAndPersistInput,
): Promise<EvaluateAndPersistResult> {
  const now = input.now ?? new Date();
  const policy = await prisma.financialPolicy.findUnique({
    where: { userId: input.userId },
  });
  const { todaySpend, todayAutonomousCount } = await computeTodaySpend(input.userId, now);
  const policySnapshot = snapshotPolicy(input.userId, policy);

  const result: PolicyResult = policy
    ? evaluatePolicy(policy, input.proposal, todaySpend, todayAutonomousCount)
    : { decision: "REQUIRE_APPROVAL", reasonCode: REASON.NO_POLICY_CONFIGURED };

  const evaluation = await prisma.policyEvaluation.create({
    data: {
      purchaseIntentId: input.purchaseIntentId,
      decision: result.decision,
      reasonCode: result.reasonCode,
      policySnapshot: policySnapshot as Prisma.InputJsonValue,
      evaluatedAt: now,
    },
  });

  return {
    decision: result.decision as PolicyDecision,
    reasonCode: result.reasonCode,
    evaluation,
    todaySpend,
    todayAutonomousCount,
    policySnapshot,
  };
}
