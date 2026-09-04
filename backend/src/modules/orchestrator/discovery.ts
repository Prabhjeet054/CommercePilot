import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import type { StructuredIntent } from "../intent/intent.schema";
import type { ProductWithAttributes } from "../ranking/score";

/**
 * Catalog row shaped for ranking, plus the persisted merchantId used to build
 * the Policy Engine proposal from stored product fields (never from the LLM).
 */
export type DiscoveredProduct = ProductWithAttributes & {
  merchantId: string;
};

/**
 * Thin deterministic catalog query (Phase 4 data, no LLM). Filters by the
 * structured intent's catalog category, budget ceiling, and in-stock only.
 */
export async function discoverCatalogCandidates(intent: StructuredIntent): Promise<DiscoveredProduct[]> {
  const category = intent.category.trim();
  if (category.length === 0 || !(intent.budget > 0)) {
    return [];
  }

  const rows = await prisma.product.findMany({
    where: {
      category: { equals: category, mode: "insensitive" },
      price: { lte: new Prisma.Decimal(intent.budget.toFixed(2)) },
      stock: { gt: 0 },
    },
    include: { merchant: true, attributes: true },
    orderBy: [{ name: "asc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    merchantId: row.merchantId,
    name: row.name,
    category: row.category,
    price: row.price,
    stock: row.stock,
    rating: row.rating,
    reviewCount: row.reviewCount,
    tags: row.tags,
    merchant: { name: row.merchant.name, trustScore: row.merchant.trustScore },
    attributes: row.attributes.map((attribute) => ({
      attrKey: attribute.attrKey,
      attrValue: attribute.attrValue,
    })),
  }));
}
