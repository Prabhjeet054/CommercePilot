import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { findMerchantIdForUser } from "../catalog/catalog.service";

/** Intents a merchant should review (PRD FR-17 + demo acceptance for approval-pending). */
export const FLAGGED_INTENT_STATUSES = [
  "POLICY_DENIED",
  "APPROVAL_REJECTED",
  "APPROVAL_PENDING",
  "PAYMENT_VERIFICATION_FAILED",
] as const;

export type FlaggedIntentStatus = (typeof FLAGGED_INTENT_STATUSES)[number];

export class MerchantNotAssociatedError extends Error {
  constructor() {
    super("MERCHANT_NOT_ASSOCIATED");
    this.name = "MerchantNotAssociatedError";
  }
}

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
  /** Sum of COMPLETED order amounts for this merchant's products (INR rupees). */
  gmv: string;
  completedOrderCount: number;
  /** Intents that ranked+selected one of this merchant's products. */
  eligibleIntentCount: number;
  /** completedOrderCount / eligibleIntentCount, or 0 when denominator is 0. */
  conversionRate: number;
  averageOrderValue: string;
  topProducts: TopProductRow[];
  flaggedIntents: FlaggedIntentRow[];
  recentCompletedOrders: CompletedOrderRow[];
};

function money(value: Prisma.Decimal | number): string {
  if (value instanceof Prisma.Decimal) {
    return value.toFixed(2);
  }
  return Number(value).toFixed(2);
}

/**
 * Aggregate merchant growth metrics (PRD Sections 17 / 34).
 * All queries are strictly scoped by `merchantId` — callers must never pass null.
 */
export async function getMerchantAnalytics(merchantId: string): Promise<MerchantAnalytics> {
  if (!merchantId || merchantId.trim().length === 0) {
    throw new MerchantNotAssociatedError();
  }

  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { id: true, name: true },
  });
  if (!merchant) {
    throw new MerchantNotAssociatedError();
  }

  const completedOrders = await prisma.order.findMany({
    where: {
      state: "COMPLETED",
      product: { merchantId },
    },
    include: {
      product: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  let gmvDecimal = new Prisma.Decimal(0);
  const byProduct = new Map<string, { name: string; orderCount: number; revenue: Prisma.Decimal }>();

  for (const order of completedOrders) {
    gmvDecimal = gmvDecimal.add(order.amount);
    const existing = byProduct.get(order.productId);
    if (existing) {
      existing.orderCount += 1;
      existing.revenue = existing.revenue.add(order.amount);
    } else {
      byProduct.set(order.productId, {
        name: order.product.name,
        orderCount: 1,
        revenue: new Prisma.Decimal(order.amount),
      });
    }
  }

  const completedOrderCount = completedOrders.length;
  const averageOrderValue =
    completedOrderCount === 0
      ? "0.00"
      : money(gmvDecimal.div(completedOrderCount));

  // Ranked-and-selected: intents whose selected decision points at this merchant's catalog.
  const selectedForMerchant = await prisma.agentDecision.findMany({
    where: {
      selected: true,
      product: { merchantId },
    },
    select: {
      agentRun: { select: { purchaseIntentId: true } },
    },
  });
  const eligibleIntentIds = new Set(
    selectedForMerchant.map((row) => row.agentRun.purchaseIntentId),
  );
  const eligibleIntentCount = eligibleIntentIds.size;
  const conversionRate =
    eligibleIntentCount === 0 ? 0 : completedOrderCount / eligibleIntentCount;

  const topProducts: TopProductRow[] = [...byProduct.entries()]
    .map(([productId, row]) => ({
      productId,
      name: row.name,
      orderCount: row.orderCount,
      revenue: money(row.revenue),
    }))
    .sort((a, b) => {
      if (b.orderCount !== a.orderCount) {
        return b.orderCount - a.orderCount;
      }
      return Number(b.revenue) - Number(a.revenue);
    })
    .slice(0, 10);

  const flaggedRows = await prisma.purchaseIntent.findMany({
    where: {
      status: { in: [...FLAGGED_INTENT_STATUSES] },
      agentRun: {
        decisions: {
          some: {
            selected: true,
            product: { merchantId },
          },
        },
      },
    },
    include: {
      agentRun: {
        include: {
          decisions: {
            where: { selected: true },
            include: { product: { select: { id: true, name: true, merchantId: true } } },
            take: 1,
          },
        },
      },
      policyEvaluations: {
        orderBy: { evaluatedAt: "desc" },
        take: 1,
        select: { reasonCode: true },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  const flaggedIntents: FlaggedIntentRow[] = flaggedRows.map((intent) => {
    const selected = intent.agentRun?.decisions[0];
    const product =
      selected && selected.product.merchantId === merchantId ? selected.product : null;
    return {
      id: intent.id,
      status: intent.status,
      rawText: intent.rawText,
      selectedProductId: product?.id ?? null,
      selectedProductName: product?.name ?? null,
      reasonCode: intent.policyEvaluations[0]?.reasonCode ?? null,
      updatedAt: intent.updatedAt.toISOString(),
    };
  });

  const recentCompletedOrders: CompletedOrderRow[] = completedOrders.slice(0, 25).map((order) => ({
    id: order.id,
    amount: money(order.amount),
    currency: order.currency,
    productId: order.productId,
    productName: order.product.name,
    purchaseIntentId: order.purchaseIntentId,
    createdAt: order.createdAt.toISOString(),
  }));

  return {
    merchantId: merchant.id,
    merchantName: merchant.name,
    gmv: money(gmvDecimal),
    completedOrderCount,
    eligibleIntentCount,
    conversionRate,
    averageOrderValue,
    topProducts,
    flaggedIntents,
    recentCompletedOrders,
  };
}

/**
 * Resolve analytics for the authenticated merchant_admin.
 * Refuses null/missing merchantId — never queries with an open filter.
 */
export async function getAnalyticsForUser(userId: string): Promise<MerchantAnalytics> {
  const merchantId = await findMerchantIdForUser(userId);
  if (!merchantId) {
    throw new MerchantNotAssociatedError();
  }
  return getMerchantAnalytics(merchantId);
}
