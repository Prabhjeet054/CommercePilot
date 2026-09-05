import { prisma } from "../../lib/prisma";
import type { PolicySnapshot } from "../policy/policy.service";
import {
  assertGroundedExplanation,
  explainTopPick,
  ExplanationUngroundedError,
  numericTokens,
} from "./explain";
import type { RankingFactor } from "./score";

export class ExplainNotReadyError extends Error {
  constructor() {
    super("EXPLAIN_NOT_READY");
    this.name = "ExplainNotReadyError";
  }
}

export class ExplainNotFoundError extends Error {
  constructor() {
    super("NOT_FOUND");
    this.name = "ExplainNotFoundError";
  }
}

export type GroundedFields = {
  decision: string | null;
  reasonCode: string | null;
  productName: string | null;
  price: string | null;
  budget: string | null;
  rating: string | null;
  reviewCount: number | null;
  approvalThreshold: string | null;
  dailySpendingLimit: string | null;
  maxAutonomousAmount: string | null;
  scoreBreakdown: RankingFactor[];
  policySnapshot: PolicySnapshot | null;
};

export type ExplainResult = {
  explanation: string;
  groundedFields: GroundedFields;
  source: "template" | "llm_fallback_template" | "llm";
};

function formatInr(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function asFactors(value: unknown): RankingFactor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((row): row is RankingFactor => {
    if (!row || typeof row !== "object") {
      return false;
    }
    const factor = row as RankingFactor;
    return typeof factor.name === "string" && typeof factor.evidence === "string";
  });
}

function asSnapshot(value: unknown): PolicySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as PolicySnapshot;
}

function moneyString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return String(value);
  }
  return n.toFixed(2);
}

/**
 * Every numeric token in `explanation` must appear in the JSON of `groundedFields`
 * (score_breakdown evidence, policy snapshot thresholds, price, budget, rating, etc.).
 * Trailing zeros are normalized so `4499` matches `4499.00`.
 */
export function assertExplanationGrounded(explanation: string, groundedFields: GroundedFields): void {
  const normalize = (token: string): string => {
    if (!token.includes(".")) {
      return token;
    }
    return token.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  };
  const allowed = new Set(
    numericTokens(JSON.stringify(groundedFields)).flatMap((token) => [token, normalize(token)]),
  );
  const invented = numericTokens(explanation).filter((token) => {
    return !allowed.has(token) && !allowed.has(normalize(token));
  });
  if (invented.length > 0) {
    throw new ExplanationUngroundedError(invented);
  }
}

function templateAllow(fields: GroundedFields): string {
  const price = fields.price !== null ? formatInr(Number(fields.price)) : null;
  const budget = fields.budget !== null ? formatInr(Number(fields.budget)) : null;
  const rating = fields.rating !== null ? String(Number(fields.rating)) : null;
  const reviews = fields.reviewCount;
  const name = fields.productName ?? "this product";
  const decision = fields.decision ?? "ALLOW";
  const reason = fields.reasonCode ?? "WITHIN_POLICY";

  const parts: string[] = [];
  if (price !== null && budget !== null) {
    parts.push(
      `I selected ${name} at ₹${price} because it fits within your ₹${budget} budget`,
    );
  } else if (price !== null) {
    parts.push(`I selected ${name} at ₹${price}`);
  } else {
    parts.push(`I selected ${name}`);
  }
  if (rating !== null && reviews !== null) {
    parts.push(`and it has a ${rating}/5 rating from ${reviews} reviews`);
  } else if (rating !== null) {
    parts.push(`and it has a ${rating}/5 rating`);
  }
  const head = parts.join(" ");
  return `${head}. Policy outcome: ${decision} (${reason}).`;
}

function templatePolicyGate(fields: GroundedFields): string {
  const reason = fields.reasonCode ?? "POLICY_GATE";
  const decision = fields.decision ?? "REQUIRE_APPROVAL";

  if (reason === "AMOUNT_ABOVE_APPROVAL_THRESHOLD" && fields.approvalThreshold) {
    const threshold = formatInr(Number(fields.approvalThreshold));
    return `Policy requires approval (${reason}): the selected amount is above your approval threshold of ₹${threshold}. Decision: ${decision}.`;
  }
  if (reason === "DAILY_LIMIT_EXCEEDED" && fields.dailySpendingLimit) {
    const daily = formatInr(Number(fields.dailySpendingLimit));
    return `Policy requires approval (${reason}): this purchase would exceed your daily spending limit of ₹${daily}. Decision: ${decision}.`;
  }
  if (reason === "AMOUNT_ABOVE_MAX_AUTONOMOUS" && fields.maxAutonomousAmount) {
    const maxAuto = formatInr(Number(fields.maxAutonomousAmount));
    return `Policy requires approval (${reason}): the amount is above your max autonomous limit of ₹${maxAuto}. Decision: ${decision}.`;
  }
  if (reason === "CATEGORY_BLOCKED" || decision === "DENY") {
    return `Policy denied this purchase (${reason}). Decision: ${decision}.`;
  }
  return `Policy gated this purchase (${reason}). Decision: ${decision}.`;
}

function buildTemplate(fields: GroundedFields): string {
  if (fields.decision === "DENY" || fields.decision === "REQUIRE_APPROVAL") {
    return templatePolicyGate(fields);
  }
  return templateAllow(fields);
}

/**
 * Compose a grounded explanation from stored agent_decisions + policy_evaluations.
 * Uses a fixed template as the durable source of truth (testable, always grounded).
 * Optionally tries Phase 9 LLM narration for ALLOW paths; on grounding failure,
 * logs and falls back to the template (never returns an ungrounded string).
 */
export async function explainPurchaseIntent(
  intentId: string,
  userId: string,
  options?: {
    /** Inject a custom LLM narration attempt for tests (ALLOW path only). */
    tryLlmNarration?: (factors: RankingFactor[]) => Promise<string>;
  },
): Promise<ExplainResult> {
  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: intentId },
    include: {
      agentRun: {
        include: {
          decisions: {
            where: { selected: true },
            take: 1,
            include: {
              product: {
                select: { name: true, price: true, rating: true, reviewCount: true },
              },
            },
          },
        },
      },
      policyEvaluations: { orderBy: { evaluatedAt: "desc" }, take: 1 },
    },
  });

  if (!intent || intent.userId !== userId) {
    throw new ExplainNotFoundError();
  }

  const evaluation = intent.policyEvaluations[0] ?? null;
  const selected = intent.agentRun?.decisions[0] ?? null;
  const runStatus = intent.agentRun?.status ?? null;

  if (
    !evaluation &&
    !selected &&
    (runStatus === null || runStatus === "RUNNING" || intent.status === "CREATED")
  ) {
    throw new ExplainNotReadyError();
  }

  const structured = (intent.structuredIntent ?? {}) as { budget?: number };
  const snapshot = evaluation ? asSnapshot(evaluation.policySnapshot) : null;
  const factors = selected ? asFactors(selected.scoreBreakdown) : [];

  const groundedFields: GroundedFields = {
    decision: evaluation?.decision ?? null,
    reasonCode: evaluation?.reasonCode ?? null,
    productName: selected?.product.name ?? null,
    price: selected ? moneyString(selected.product.price.toString()) : null,
    budget:
      typeof structured.budget === "number" && Number.isFinite(structured.budget)
        ? moneyString(structured.budget)
        : null,
    rating: selected?.product.rating != null ? moneyString(selected.product.rating.toString()) : null,
    reviewCount: selected?.product.reviewCount ?? null,
    approvalThreshold: snapshot?.approvalThreshold ?? null,
    dailySpendingLimit: snapshot?.dailySpendingLimit ?? null,
    maxAutonomousAmount: snapshot?.maxAutonomousAmount ?? null,
    scoreBreakdown: factors,
    policySnapshot: snapshot,
  };

  const template = buildTemplate(groundedFields);
  assertExplanationGrounded(template, groundedFields);

  const allowPath =
    groundedFields.decision === "ALLOW" ||
    intent.status === "POLICY_ALLOWED" ||
    intent.status === "COMPLETED" ||
    intent.status === "ORDER_CREATED" ||
    intent.status === "PAYMENT_AUTHORIZED" ||
    intent.status === "PAYMENT_CAPTURED" ||
    intent.status === "APPROVED";

  if (allowPath && factors.length > 0) {
    try {
      const narrate =
        options?.tryLlmNarration ??
        ((f: RankingFactor[]) => explainTopPick(f));
      const llmText = (await narrate(factors)).trim();
      assertExplanationGrounded(llmText, groundedFields);
      // Also reuse Phase 9 factor-only check for belt-and-suspenders.
      assertGroundedExplanation(llmText, factors);
      return { explanation: llmText, groundedFields, source: "llm" };
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "explain_ungrounded_fallback",
          intentId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return { explanation: template, groundedFields, source: "llm_fallback_template" };
    }
  }

  return { explanation: template, groundedFields, source: "template" };
}
