import { formatInr } from "@/lib/policy-schema";

export const DEMO_INTENT_PHRASE =
  "I need running shoes under ₹5,000. I run around 25 km every week. Buy the best option automatically.";

export const DEMO_LAPTOP_PHRASE = "Buy me a laptop for ₹1,20,000";

/** Budget below every seeded Sports price — used to force NO_MATCHING_PRODUCTS. */
export const LOW_BUDGET_SPORTS_PHRASE = "I want running shoes under ₹50";

export type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type RankingFactor = {
  name: string;
  score: number;
  weight: number;
  evidence: string;
};

export type RankedCandidate = {
  productId: string;
  name: string;
  category: string;
  price: string;
  merchantId: string;
  score: number;
  rank: number;
  selected: boolean;
  factors: RankingFactor[];
};

export type StructuredIntentView = {
  category?: string;
  extractedCategory?: string;
  categoryMatch?: string;
  budget?: number;
  currency?: string;
  purpose?: string;
  usage?: string;
  priority?: string;
  purchaseMode?: string;
  confidence?: number;
  hasAdditionalUnparsedRequest?: boolean;
};

export type PolicyDecisionView = {
  decision: string;
  reasonCode: string;
  evaluationId: string;
};

export type ApprovalSummaryView = {
  id: string;
  status: string;
  expiresAt: string | null;
  reasonCode: string | null;
  amount: string | null;
};

export type SelectedProductView = {
  id: string;
  name: string;
  price: string;
  category: string;
  merchantId: string;
};

export type PurchaseIntentView = {
  id: string;
  rawText: string;
  status: string;
  result: string;
  purchaseMode: "autonomous" | "manual";
  intent: StructuredIntentView;
  rankedCandidates: RankedCandidate[];
  selectedProduct: SelectedProductView | null;
  policyDecision: PolicyDecisionView | null;
  approval: ApprovalSummaryView | null;
};

export type PurchaseIntentListItem = {
  id: string;
  rawText: string;
  status: string;
  purchaseMode: string;
  createdAt: string;
};

export class PurchaseIntentApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PurchaseIntentApiError";
    this.code = code;
  }
}

function friendlyMessage(code: string, fallback?: string): string {
  if (fallback && fallback.trim().length > 0 && !/^[A-Z][A-Z0-9_]+$/.test(fallback)) {
    return fallback;
  }
  if (code === "NO_MATCHING_PRODUCTS") {
    return "I couldn't find a product that matches that request. Try a different category or budget.";
  }
  if (
    code === "IntentExtractionError" ||
    code === "LLMOutputError" ||
    code === "IntentPromptError" ||
    code === "IntentBudgetError"
  ) {
    return fallback && fallback.trim().length > 0
      ? fallback
      : "I couldn't understand that request. Could you rephrase?";
  }
  return fallback && fallback.trim().length > 0 ? fallback : "Something went wrong. Please try again.";
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function assertOk(response: Response): Promise<Record<string, unknown>> {
  const body = await readBody(response);
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "REQUEST_FAILED";
    const message = typeof body.message === "string" ? body.message : undefined;
    throw new PurchaseIntentApiError(code, friendlyMessage(code, message));
  }
  return body;
}

function asFactors(value: unknown): RankingFactor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is RankingFactor => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const row = item as RankingFactor;
    return typeof row.evidence === "string" && typeof row.name === "string";
  });
}

function asApprovalSummary(value: unknown): ApprovalSummaryView | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string") {
    return null;
  }
  return {
    id: row.id,
    status: String(row.status ?? ""),
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    reasonCode: typeof row.reasonCode === "string" ? row.reasonCode : null,
    amount: typeof row.amount === "string" ? row.amount : null,
  };
}

function resultFromStored(status: string, hasDecisions: boolean, hasPolicy: boolean): string {
  if (
    status === "POLICY_ALLOWED" ||
    status === "APPROVAL_PENDING" ||
    status === "POLICY_DENIED" ||
    status === "APPROVED" ||
    status === "APPROVAL_REJECTED"
  ) {
    return status;
  }
  if (!hasDecisions && !hasPolicy) {
    return "NO_MATCHING_PRODUCTS";
  }
  return status;
}

export function formatPrice(price: string | number): string {
  return `₹${formatInr(Number(price))}`;
}

export function fromCreateResponse(
  body: Record<string, unknown>,
  rawText: string,
): PurchaseIntentView {
  const ranked = Array.isArray(body.rankedCandidates)
    ? (body.rankedCandidates as RankedCandidate[])
    : [];
  const selected = (body.selectedProduct as SelectedProductView | null) ?? null;
  const policy = (body.policyDecision as PolicyDecisionView | null) ?? null;
  const result = typeof body.result === "string" ? body.result : String(body.status ?? "");

  return {
    id: String(body.id),
    rawText,
    status: String(body.status ?? ""),
    result,
    purchaseMode: body.purchaseMode === "autonomous" ? "autonomous" : "manual",
    intent: (body.intent as StructuredIntentView) ?? {},
    rankedCandidates: ranked.map((row) => ({
      ...row,
      factors: asFactors(row.factors),
    })),
    selectedProduct: selected,
    policyDecision: policy,
    approval: asApprovalSummary(body.approval),
  };
}

export function fromStoredResponse(body: Record<string, unknown>): PurchaseIntentView {
  const agentRun = body.agentRun as
    | {
        decisions?: Array<{
          productId: string;
          name?: string;
          price?: string;
          category?: string;
          merchantId?: string;
          score?: string | number | null;
          rank?: number | null;
          selected?: boolean;
          factors?: unknown;
          scoreBreakdown?: unknown;
        }>;
      }
    | null;
  const decisions = agentRun?.decisions ?? [];
  const evaluations = Array.isArray(body.policyEvaluations)
    ? (body.policyEvaluations as Array<{ id: string; decision: string; reasonCode: string }>)
    : [];
  const latest = evaluations[evaluations.length - 1];
  const ranked: RankedCandidate[] = decisions.map((decision, index) => ({
    productId: decision.productId,
    name: decision.name ?? decision.productId,
    category: decision.category ?? "",
    price: decision.price ?? "0.00",
    merchantId: decision.merchantId ?? "",
    score: Number(decision.score ?? 0),
    rank: decision.rank ?? index + 1,
    selected: Boolean(decision.selected),
    factors: asFactors(decision.factors ?? decision.scoreBreakdown),
  }));
  const picked = ranked.find((row) => row.selected) ?? null;

  return {
    id: String(body.id),
    rawText: String(body.rawText ?? ""),
    status: String(body.status ?? ""),
    result: resultFromStored(String(body.status ?? ""), ranked.length > 0, Boolean(latest)),
    purchaseMode: body.purchaseMode === "autonomous" ? "autonomous" : "manual",
    intent: (body.structuredIntent as StructuredIntentView) ?? {},
    rankedCandidates: ranked,
    selectedProduct: picked
      ? {
          id: picked.productId,
          name: picked.name,
          price: picked.price,
          category: picked.category,
          merchantId: picked.merchantId,
        }
      : null,
    policyDecision: latest
      ? { decision: latest.decision, reasonCode: latest.reasonCode, evaluationId: latest.id }
      : null,
    approval: asApprovalSummary(body.approval),
  };
}

export async function createPurchaseIntent(
  authFetch: AuthFetch,
  input: { text: string; purchaseMode: "autonomous" | "manual" },
): Promise<PurchaseIntentView> {
  const response = await authFetch("/purchase-intents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await assertOk(response);
  return fromCreateResponse(body, input.text);
}

export async function getPurchaseIntent(authFetch: AuthFetch, id: string): Promise<PurchaseIntentView> {
  const response = await authFetch(`/purchase-intents/${id}`);
  const body = await assertOk(response);
  return fromStoredResponse(body);
}

export async function listPurchaseIntents(authFetch: AuthFetch): Promise<PurchaseIntentListItem[]> {
  const response = await authFetch("/purchase-intents");
  const body = await assertOk(response);
  return Array.isArray(body.intents) ? (body.intents as PurchaseIntentListItem[]) : [];
}

export function statusTone(status: string): "completed" | "pending" | "denied" {
  if (status === "POLICY_ALLOWED" || status === "COMPLETED") {
    return "completed";
  }
  if (status === "POLICY_DENIED" || status === "NO_MATCHING_PRODUCTS") {
    return "denied";
  }
  return "pending";
}
