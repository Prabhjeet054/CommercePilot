import { Prisma, type AgentRun, type Approval, type PolicyEvaluation, type PurchaseIntent } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  applyPurchaseIntentEvent,
  INITIAL_INTENT_STATE,
  policyEventForDecision,
} from "../../lib/state-machine";
import { createApproval } from "../approvals/approval.service";
import { extractIntent } from "../intent/intent-agent";
import type { PurchaseMode, StructuredIntent } from "../intent/intent.schema";
import { evaluateAndPersist } from "../policy/policy.service";
import { rankProducts, type RankedCandidate } from "../ranking/rank";
import { discoverCatalogCandidates, type DiscoveredProduct } from "./discovery";

export const DEMO_LAPTOP_PHRASE = "Buy me a laptop for ₹1,20,000";

export const PIPELINE_RESULT = {
  POLICY_ALLOWED: "POLICY_ALLOWED",
  APPROVAL_PENDING: "APPROVAL_PENDING",
  POLICY_DENIED: "POLICY_DENIED",
  NO_MATCHING_PRODUCTS: "NO_MATCHING_PRODUCTS",
} as const;

export type PipelineResultCode = (typeof PIPELINE_RESULT)[keyof typeof PIPELINE_RESULT];

/**
 * The only shape the Orchestrator is allowed to feed the Policy Engine.
 * `amount`, `category`, and `merchantId` MUST come from the selected product's
 * already-persisted catalog row — never from structured-intent / LLM fields.
 * `userId` and `productId` identify whose policy and which product; they are
 * not LLM output either.
 */
export type PolicyProposal = {
  userId: string;
  productId: string;
  amount: number;
  category: string;
  merchantId: string;
};

export type RankedCandidateDto = {
  productId: string;
  name: string;
  category: string;
  price: string;
  merchantId: string;
  score: number;
  rank: number;
  selected: boolean;
  factors: RankedCandidate["factors"];
};

export type PolicyDecisionDto = {
  decision: string;
  reasonCode: string;
  evaluationId: string;
};

export type ApprovalSummaryDto = {
  id: string;
  status: string;
  expiresAt: string | null;
  reasonCode: string | null;
  amount: string | null;
};

export type PurchaseIntentPipelineResult = {
  id: string;
  status: string;
  result: PipelineResultCode;
  purchaseMode: PurchaseMode;
  intent: StructuredIntent;
  rankedCandidates: RankedCandidateDto[];
  selectedProduct: {
    id: string;
    name: string;
    price: string;
    category: string;
    merchantId: string;
  } | null;
  policyDecision: PolicyDecisionDto | null;
  approval: ApprovalSummaryDto | null;
};

type DecisionWithProduct = Prisma.AgentDecisionGetPayload<{
  include: {
    product: { select: { name: true; price: true; category: true; merchantId: true } };
  };
}>;

export type StoredPurchaseIntent = {
  intent: PurchaseIntent;
  agentRun: (AgentRun & { decisions: DecisionWithProduct[] }) | null;
  policyEvaluations: PolicyEvaluation[];
  approval: Approval | null;
  order: {
    id: string;
    state: string;
    razorpayOrderId: string | null;
    amount: { toFixed(digits: number): string };
    currency: string;
    payments: Array<{
      id: string;
      status: string;
      razorpayPaymentId: string | null;
      signatureVerified: boolean;
    }>;
  } | null;
};

function toApprovalSummary(approval: Approval | null): ApprovalSummaryDto | null {
  if (!approval) {
    return null;
  }
  return {
    id: approval.id,
    status: approval.status,
    expiresAt: approval.expiresAt?.toISOString() ?? null,
    reasonCode: approval.reasonCode,
    amount: approval.amount ? approval.amount.toFixed(2) : null,
  };
}

export type PurchaseIntentListItem = {
  id: string;
  rawText: string;
  status: string;
  purchaseMode: string;
  createdAt: string;
};

function rupees(value: { toString(): string } | number | string): number {
  return Number(Number(value.toString()).toFixed(2));
}

/**
 * Builds the Policy Engine proposal exclusively from stored catalog fields.
 * Never reads structured-intent budget, category, or merchant from the LLM.
 */
export function buildPolicyProposal(
  userId: string,
  product: Pick<DiscoveredProduct, "id" | "price" | "category" | "merchantId">,
): PolicyProposal {
  return {
    userId,
    productId: product.id,
    amount: rupees(product.price),
    category: product.category,
    merchantId: product.merchantId,
  };
}

function policyStatusForDecision(decision: string): PipelineResultCode {
  if (decision === "ALLOW") {
    return PIPELINE_RESULT.POLICY_ALLOWED;
  }
  if (decision === "REQUIRE_APPROVAL") {
    return PIPELINE_RESULT.APPROVAL_PENDING;
  }
  return PIPELINE_RESULT.POLICY_DENIED;
}

function toRankedDtos(
  ranked: RankedCandidate[],
  candidatesById: Map<string, DiscoveredProduct>,
  selectedId: string | null,
): RankedCandidateDto[] {
  return ranked.map((row, index) => {
    const discovered = candidatesById.get(row.product.id);
    return {
      productId: row.product.id,
      name: row.product.name,
      category: row.product.category,
      price: rupees(row.product.price).toFixed(2),
      merchantId: discovered?.merchantId ?? "",
      score: row.score,
      rank: index + 1,
      selected: selectedId !== null && row.product.id === selectedId,
      factors: row.factors,
    };
  });
}

async function persistDecisions(
  agentRunId: string,
  ranked: RankedCandidate[],
  selectedId: string | null,
): Promise<void> {
  if (ranked.length === 0) {
    return;
  }

  await prisma.agentDecision.createMany({
    data: ranked.map((row, index) => ({
      agentRunId,
      productId: row.product.id,
      score: new Prisma.Decimal(row.score.toFixed(2)),
      scoreBreakdown: row.factors as unknown as Prisma.InputJsonValue,
      rank: index + 1,
      selected: selectedId !== null && row.product.id === selectedId,
    })),
  });
}

export type RunPurchaseIntentInput = {
  userId: string;
  text: string;
  purchaseMode: PurchaseMode;
};

export async function runPurchaseIntentPipeline(
  input: RunPurchaseIntentInput,
): Promise<PurchaseIntentPipelineResult> {
  const created = await prisma.purchaseIntent.create({
    data: {
      userId: input.userId,
      rawText: input.text,
      structuredIntent: {},
      purchaseMode: input.purchaseMode,
      status: INITIAL_INTENT_STATE,
    },
  });

  const agentRun = await prisma.agentRun.create({
    data: {
      purchaseIntentId: created.id,
      status: "RUNNING",
    },
  });

  let intent: StructuredIntent;
  try {
    intent = await extractIntent(input.text);
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: { status: "FAILED", completedAt: new Date() },
    });
    throw err;
  }

  await prisma.purchaseIntent.update({
    where: { id: created.id },
    data: {
      structuredIntent: intent as unknown as Prisma.InputJsonValue,
      // Persist the request's declared mode; structured_intent.purchaseMode is advisory.
      purchaseMode: input.purchaseMode,
    },
  });
  await applyPurchaseIntentEvent(created.id, "intent_extracted");

  const candidates = await discoverCatalogCandidates(intent);
  const candidatesById = new Map(candidates.map((product) => [product.id, product]));

  if (candidates.length === 0) {
    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: { status: PIPELINE_RESULT.NO_MATCHING_PRODUCTS, completedAt: new Date() },
    });
    return {
      id: created.id,
      status: "INTENT_EXTRACTED",
      result: PIPELINE_RESULT.NO_MATCHING_PRODUCTS,
      purchaseMode: input.purchaseMode,
      intent,
      rankedCandidates: [],
      selectedProduct: null,
      policyDecision: null,
      approval: null,
    };
  }

  const { ranked, selected } = rankProducts(candidates, intent);
  const selectedId = selected?.product.id ?? null;
  await persistDecisions(agentRun.id, ranked, selectedId);
  await applyPurchaseIntentEvent(created.id, "products_ranked");

  const rankedCandidates = toRankedDtos(ranked, candidatesById, selectedId);

  if (!selected || !selectedId) {
    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: { status: PIPELINE_RESULT.NO_MATCHING_PRODUCTS, completedAt: new Date() },
    });
    return {
      id: created.id,
      status: "PRODUCTS_RANKED",
      result: PIPELINE_RESULT.NO_MATCHING_PRODUCTS,
      purchaseMode: input.purchaseMode,
      intent,
      rankedCandidates,
      selectedProduct: null,
      policyDecision: null,
      approval: null,
    };
  }

  const discovered = candidatesById.get(selectedId);
  if (!discovered) {
    throw new Error("Selected product missing from discovery set");
  }

  const proposal = buildPolicyProposal(input.userId, discovered);

  const policy = await evaluateAndPersist({
    userId: proposal.userId,
    purchaseIntentId: created.id,
    proposal: {
      amount: proposal.amount,
      category: proposal.category,
      merchantId: proposal.merchantId,
    },
  });

  const result = policyStatusForDecision(policy.decision);
  let approval: Approval | null = null;
  if (policy.decision === "REQUIRE_APPROVAL") {
    approval = await createApproval({
      purchaseIntentId: created.id,
      userId: input.userId,
      productId: discovered.id,
      amount: proposal.amount,
      policyEvaluationId: policy.evaluation.id,
      reasonCode: policy.reasonCode,
    });
  }
  await applyPurchaseIntentEvent(created.id, policyEventForDecision(policy.decision));
  await prisma.agentRun.update({
    where: { id: agentRun.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  return {
    id: created.id,
    status: result,
    result,
    purchaseMode: input.purchaseMode,
    intent,
    rankedCandidates,
    selectedProduct: {
      id: discovered.id,
      name: discovered.name,
      price: proposal.amount.toFixed(2),
      category: discovered.category,
      merchantId: discovered.merchantId,
    },
    policyDecision: {
      decision: policy.decision,
      reasonCode: policy.reasonCode,
      evaluationId: policy.evaluation.id,
    },
    approval: toApprovalSummary(approval),
  };
}

export async function listPurchaseIntentsForUser(userId: string): Promise<PurchaseIntentListItem[]> {
  const rows = await prisma.purchaseIntent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, rawText: true, status: true, purchaseMode: true, createdAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    rawText: row.rawText,
    status: row.status,
    purchaseMode: row.purchaseMode,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function getStoredPurchaseIntent(
  id: string,
  userId: string,
): Promise<StoredPurchaseIntent | null> {
  const intent = await prisma.purchaseIntent.findUnique({
    where: { id },
    include: {
      agentRun: {
        include: {
          decisions: {
            orderBy: { rank: "asc" },
            include: {
              product: { select: { name: true, price: true, category: true, merchantId: true } },
            },
          },
        },
      },
      policyEvaluations: { orderBy: { evaluatedAt: "asc" } },
      approval: true,
      order: {
        select: {
          id: true,
          state: true,
          razorpayOrderId: true,
          amount: true,
          currency: true,
          payments: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              status: true,
              razorpayPaymentId: true,
              signatureVerified: true,
            },
          },
        },
      },
    },
  });
  if (!intent || intent.userId !== userId) {
    return null;
  }

  const { agentRun, policyEvaluations, approval, order, ...row } = intent;
  return {
    intent: row,
    agentRun,
    policyEvaluations,
    approval,
    order,
  };
}

export function serializeStoredPurchaseIntent(stored: StoredPurchaseIntent) {
  return {
    id: stored.intent.id,
    userId: stored.intent.userId,
    rawText: stored.intent.rawText,
    structuredIntent: stored.intent.structuredIntent,
    purchaseMode: stored.intent.purchaseMode,
    status: stored.intent.status,
    createdAt: stored.intent.createdAt.toISOString(),
    updatedAt: stored.intent.updatedAt.toISOString(),
    agentRun: stored.agentRun
      ? {
          id: stored.agentRun.id,
          status: stored.agentRun.status,
          startedAt: stored.agentRun.startedAt.toISOString(),
          completedAt: stored.agentRun.completedAt?.toISOString() ?? null,
          decisions: stored.agentRun.decisions.map((decision) => ({
            id: decision.id,
            productId: decision.productId,
            name: decision.product.name,
            price: decision.product.price.toFixed(2),
            category: decision.product.category,
            merchantId: decision.product.merchantId,
            score: decision.score ? decision.score.toFixed(2) : null,
            scoreBreakdown: decision.scoreBreakdown,
            factors: decision.scoreBreakdown,
            rank: decision.rank,
            selected: decision.selected,
          })),
        }
      : null,
    policyEvaluations: stored.policyEvaluations.map((evaluation) => ({
      id: evaluation.id,
      decision: evaluation.decision,
      reasonCode: evaluation.reasonCode,
      policySnapshot: evaluation.policySnapshot,
      evaluatedAt: evaluation.evaluatedAt.toISOString(),
    })),
    approval: toApprovalSummary(stored.approval),
    orderCount: stored.order ? 1 : 0,
    order: stored.order
      ? {
          id: stored.order.id,
          state: stored.order.state,
          razorpayOrderId: stored.order.razorpayOrderId,
          amount: stored.order.amount.toFixed(2),
          currency: stored.order.currency,
          paymentStatus: stored.order.payments[stored.order.payments.length - 1]?.status ?? null,
          payments: stored.order.payments.map((payment) => ({
            id: payment.id,
            status: payment.status,
            razorpayPaymentId: payment.razorpayPaymentId,
            signatureVerified: payment.signatureVerified,
          })),
        }
      : null,
  };
}
