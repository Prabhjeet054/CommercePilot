import type { AuthFetch } from "@/lib/api/purchase-intents";

export type GroundedFieldsView = {
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
};

export type ExplainView = {
  explanation: string;
  groundedFields: GroundedFieldsView;
  source: string;
};

export class ExplainApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ExplainApiError";
    this.code = code;
    this.status = status;
  }
}

export async function getDecisionExplanation(
  authFetch: AuthFetch,
  intentId: string,
): Promise<ExplainView> {
  const response = await authFetch(`/agent/decisions/${intentId}/explain`);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 409) {
    throw new ExplainApiError(
      "EXPLAIN_NOT_READY",
      typeof body.message === "string" ? body.message : "Explanation is not ready yet.",
      409,
    );
  }
  if (!response.ok) {
    throw new ExplainApiError(
      typeof body.error === "string" ? body.error : "REQUEST_FAILED",
      "Could not load explanation.",
      response.status,
    );
  }
  return {
    explanation: String(body.explanation ?? ""),
    groundedFields: (body.groundedFields as GroundedFieldsView) ?? {
      decision: null,
      reasonCode: null,
      productName: null,
      price: null,
      budget: null,
      rating: null,
      reviewCount: null,
      approvalThreshold: null,
      dailySpendingLimit: null,
      maxAutonomousAmount: null,
    },
    source: String(body.source ?? "template"),
  };
}
