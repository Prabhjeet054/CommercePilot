import { Prisma, type Approval } from "@prisma/client";
import { loadEnv } from "../../config/env";
import { applyPurchaseIntentEvent, IllegalTransitionError } from "../../lib/state-machine";
import { prisma } from "../../lib/prisma";
import type { PolicySnapshot } from "../policy/policy.service";

export const DECISION_CONFLICT = {
  ALREADY_CONSUMED: "ALREADY_CONSUMED",
  EXPIRED: "EXPIRED",
  NOT_FOUND: "NOT_FOUND",
} as const;

export type DecisionConflict = (typeof DECISION_CONFLICT)[keyof typeof DECISION_CONFLICT];

export type CreateApprovalInput = {
  purchaseIntentId: string;
  userId: string;
  productId: string;
  amount: number;
  policyEvaluationId: string;
  reasonCode: string;
  now?: Date;
};

export type DecideApprovalResult =
  | { ok: true; approval: Approval }
  | { ok: false; reason: DecisionConflict };

export type ApprovalDto = {
  id: string;
  purchaseIntentId: string;
  userId: string;
  productId: string;
  productName: string;
  merchantName: string;
  amount: string;
  reasonCode: string | null;
  reason: string;
  approvalThreshold: string | null;
  dailySpendingLimit: string | null;
  status: string;
  expiresAt: string | null;
  consumedAt: string | null;
  createdAt: string;
  rationale: string[];
};

type ApprovalDetail = Prisma.ApprovalGetPayload<{
  include: {
    product: { include: { merchant: { select: { name: true } } } };
    policyEvaluation: { select: { policySnapshot: true; reasonCode: true } };
    purchaseIntent: {
      include: {
        agentRun: {
          include: {
            decisions: true;
          };
        };
      };
    };
  };
}>;

export const approvalDetailInclude = {
  product: { include: { merchant: { select: { name: true } } } },
  policyEvaluation: { select: { policySnapshot: true, reasonCode: true } },
  purchaseIntent: {
    include: {
      agentRun: {
        include: {
          decisions: { where: { selected: true }, take: 1 },
        },
      },
    },
  },
} as const;

export function approvalTtlMinutes(): number {
  return loadEnv().APPROVAL_TTL_MINUTES;
}

function inr(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return value;
  }
  return `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function asSnapshot(value: Prisma.JsonValue | null | undefined): PolicySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as unknown as PolicySnapshot;
}

function describeReason(reasonCode: string | null, snapshot: PolicySnapshot | null): string {
  const threshold = inr(snapshot?.approvalThreshold ?? null);
  const daily = inr(snapshot?.dailySpendingLimit ?? null);
  switch (reasonCode) {
    case "AMOUNT_ABOVE_APPROVAL_THRESHOLD":
      return threshold
        ? `This amount is above your approval threshold of ${threshold}.`
        : "This amount is above your approval threshold.";
    case "DAILY_LIMIT_EXCEEDED":
      return daily
        ? `This purchase would exceed your daily spending limit of ${daily}.`
        : "This purchase would exceed your daily spending limit.";
    case "AMOUNT_ABOVE_MAX_AUTONOMOUS":
      return "This amount is above your maximum autonomous purchase limit.";
    case "AUTONOMOUS_DISABLED":
      return "Autonomous purchasing is turned off, so this purchase needs your approval.";
    case "MAX_AUTONOMOUS_TXNS_REACHED":
      return "You have reached the maximum number of autonomous purchases for today.";
    case "MERCHANT_NOT_TRUSTED":
      return "This merchant is not on your trusted list.";
    case "NO_POLICY_CONFIGURED":
      return "No financial policy is configured, so this purchase needs your approval.";
    default:
      return reasonCode
        ? `Policy requires approval (${reasonCode}).`
        : "Policy requires your approval before this purchase can continue.";
  }
}

function extractRationale(detail: ApprovalDetail): string[] {
  const selected = detail.purchaseIntent.agentRun?.decisions.find((row) => row.selected) ?? null;
  if (selected?.rationale && selected.rationale.trim().length > 0) {
    return [selected.rationale];
  }
  const breakdown = selected?.scoreBreakdown;
  if (!Array.isArray(breakdown)) {
    return [];
  }
  return breakdown
    .map((factor) => {
      if (!factor || typeof factor !== "object" || Array.isArray(factor)) {
        return null;
      }
      const evidence = (factor as { evidence?: unknown }).evidence;
      return typeof evidence === "string" && evidence.trim().length > 0 ? evidence : null;
    })
    .filter((value): value is string => Boolean(value));
}

export function serializeApproval(detail: ApprovalDetail): ApprovalDto {
  const snapshot = asSnapshot(detail.policyEvaluation?.policySnapshot ?? null);
  const reasonCode = detail.reasonCode ?? detail.policyEvaluation?.reasonCode ?? null;
  return {
    id: detail.id,
    purchaseIntentId: detail.purchaseIntentId,
    userId: detail.userId,
    productId: detail.productId,
    productName: detail.product.name,
    merchantName: detail.product.merchant.name,
    amount: detail.amount ? detail.amount.toFixed(2) : "0.00",
    reasonCode,
    reason: describeReason(reasonCode, snapshot),
    approvalThreshold: snapshot?.approvalThreshold ?? null,
    dailySpendingLimit: snapshot?.dailySpendingLimit ?? null,
    status: detail.status,
    expiresAt: detail.expiresAt?.toISOString() ?? null,
    consumedAt: detail.consumedAt?.toISOString() ?? null,
    createdAt: detail.createdAt.toISOString(),
    rationale: extractRationale(detail),
  };
}

export async function createApproval(input: CreateApprovalInput): Promise<Approval> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + approvalTtlMinutes() * 60_000);

  return prisma.approval.create({
    data: {
      purchaseIntentId: input.purchaseIntentId,
      userId: input.userId,
      productId: input.productId,
      amount: new Prisma.Decimal(input.amount.toFixed(2)),
      policyEvaluationId: input.policyEvaluationId,
      reasonCode: input.reasonCode,
      status: "PENDING",
      expiresAt,
    },
  });
}

/**
 * Single-use consume: one conditional UPDATE; affected-row count is the source of truth.
 *
 * Equivalent SQL (Prisma `updateMany` compiles to this shape):
 *   UPDATE "approvals"
 *   SET "status" = $newStatus, "consumed_at" = $now
 *   WHERE "id" = $id
 *     AND "user_id" = $userId
 *     AND "status" = 'PENDING'
 *     AND "expires_at" > $now
 */
export async function decideApproval(
  approvalId: string,
  userId: string,
  decision: "approve" | "reject",
  now: Date = new Date(),
): Promise<DecideApprovalResult> {
  const nextStatus = decision === "approve" ? "APPROVED" : "REJECTED";
  const intentEvent = decision === "approve" ? "approved" : "rejected";

  const applied = await prisma.$transaction(async (tx) => {
    const result = await tx.approval.updateMany({
      where: {
        id: approvalId,
        userId,
        status: "PENDING",
        expiresAt: { gt: now },
      },
      data: {
        status: nextStatus,
        consumedAt: now,
      },
    });
    if (result.count !== 1) {
      return null;
    }
    const approval = await tx.approval.findUniqueOrThrow({ where: { id: approvalId } });
    await applyPurchaseIntentEvent(approval.purchaseIntentId, intentEvent, tx);
    return approval;
  });

  if (applied) {
    return { ok: true, approval: applied };
  }

  const existing = await prisma.approval.findFirst({
    where: { id: approvalId, userId },
  });
  if (!existing) {
    return { ok: false, reason: DECISION_CONFLICT.NOT_FOUND };
  }
  const expired =
    existing.status === "EXPIRED" ||
    (existing.status === "PENDING" &&
      existing.expiresAt !== null &&
      existing.expiresAt.getTime() <= now.getTime());
  if (expired) {
    if (existing.status === "PENDING") {
      await prisma.approval.updateMany({
        where: { id: approvalId, userId, status: "PENDING" },
        data: { status: "EXPIRED" },
      });
    }
    try {
      await applyPurchaseIntentEvent(existing.purchaseIntentId, "expired");
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) {
        throw err;
      }
    }
    return { ok: false, reason: DECISION_CONFLICT.EXPIRED };
  }
  return { ok: false, reason: DECISION_CONFLICT.ALREADY_CONSUMED };
}

export async function listPendingApprovals(userId: string, now: Date = new Date()) {
  return prisma.approval.findMany({
    where: {
      userId,
      status: "PENDING",
      expiresAt: { gt: now },
    },
    include: approvalDetailInclude,
    orderBy: { createdAt: "desc" },
  });
}

export async function getApprovalForUser(id: string, userId: string) {
  return prisma.approval.findFirst({
    where: { id, userId },
    include: approvalDetailInclude,
  });
}
