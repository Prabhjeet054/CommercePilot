import type { AuthFetch } from "@/lib/api/purchase-intents";

export type TopProductRow = {
  productId: string;
  name: string;
  orderCount: number;
  revenue: string;
};

export type FlaggedIntentRow = {
  id: string;
  status: string;
  rawText: string;
  selectedProductId: string | null;
  selectedProductName: string | null;
  reasonCode: string | null;
  updatedAt: string;
};

export type CompletedOrderRow = {
  id: string;
  amount: string;
  currency: string;
  productId: string;
  productName: string;
  purchaseIntentId: string;
  createdAt: string;
};

export type MerchantAnalytics = {
  merchantId: string;
  merchantName: string;
  gmv: string;
  completedOrderCount: number;
  eligibleIntentCount: number;
  conversionRate: number;
  averageOrderValue: string;
  topProducts: TopProductRow[];
  flaggedIntents: FlaggedIntentRow[];
  recentCompletedOrders: CompletedOrderRow[];
};

export class AnalyticsApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AnalyticsApiError";
    this.code = code;
    this.status = status;
  }
}

export async function fetchMerchantAnalytics(authFetch: AuthFetch): Promise<MerchantAnalytics> {
  const response = await authFetch("/analytics/merchant");
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "ANALYTICS_FAILED";
    const message =
      typeof body.message === "string"
        ? body.message
        : code === "MERCHANT_NOT_ASSOCIATED"
          ? "No merchant is associated with this admin account."
          : "Could not load merchant analytics.";
    throw new AnalyticsApiError(code, message, response.status);
  }

  return body as unknown as MerchantAnalytics;
}
