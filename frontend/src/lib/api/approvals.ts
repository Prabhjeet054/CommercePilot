import { formatPrice } from "@/lib/api/purchase-intents";

export type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type ApprovalView = {
  id: string;
  purchaseIntentId: string;
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

export class ApprovalApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ApprovalApiError";
    this.code = code;
    this.status = status;
  }
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function conflictMessage(code: string): string {
  if (code === "ALREADY_CONSUMED") {
    return "This approval has already been used.";
  }
  if (code === "EXPIRED") {
    return "This approval has expired.";
  }
  return "This approval can no longer be decided.";
}

async function assertOk(response: Response): Promise<Record<string, unknown>> {
  const body = await readBody(response);
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "REQUEST_FAILED";
    const message =
      response.status === 409
        ? conflictMessage(code)
        : typeof body.message === "string"
          ? body.message
          : "Could not load this approval.";
    throw new ApprovalApiError(code, response.status, message);
  }
  return body;
}

function asApproval(body: Record<string, unknown>): ApprovalView {
  const rationale = Array.isArray(body.rationale)
    ? body.rationale.filter((row): row is string => typeof row === "string")
    : [];
  return {
    id: String(body.id),
    purchaseIntentId: String(body.purchaseIntentId),
    productId: String(body.productId),
    productName: String(body.productName ?? ""),
    merchantName: String(body.merchantName ?? ""),
    amount: String(body.amount ?? "0.00"),
    reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : null,
    reason: typeof body.reason === "string" ? body.reason : "Policy requires your approval.",
    approvalThreshold: typeof body.approvalThreshold === "string" ? body.approvalThreshold : null,
    dailySpendingLimit: typeof body.dailySpendingLimit === "string" ? body.dailySpendingLimit : null,
    status: String(body.status ?? ""),
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
    consumedAt: typeof body.consumedAt === "string" ? body.consumedAt : null,
    createdAt: String(body.createdAt ?? ""),
    rationale,
  };
}

export async function listPendingApprovals(authFetch: AuthFetch): Promise<ApprovalView[]> {
  const response = await authFetch("/approvals/pending");
  const body = await assertOk(response);
  return Array.isArray(body.approvals)
    ? (body.approvals as Record<string, unknown>[]).map(asApproval)
    : [];
}

export async function getApproval(authFetch: AuthFetch, id: string): Promise<ApprovalView> {
  const response = await authFetch(`/approvals/${id}`);
  const body = await assertOk(response);
  return asApproval(body);
}

export async function decideApproval(
  authFetch: AuthFetch,
  id: string,
  decision: "approve" | "reject",
): Promise<ApprovalView> {
  const response = await authFetch(`/approvals/${id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  const body = await assertOk(response);
  return asApproval(body);
}

export { formatPrice };
