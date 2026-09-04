import { scoreProduct, type ProductScore, type ProductWithAttributes } from "./score";
import type { StructuredIntent } from "../intent/intent.schema";

export type RankedCandidate = ProductScore & {
  product: ProductWithAttributes;
};

export type RankResult = {
  ranked: RankedCandidate[];
  selected: RankedCandidate | null;
};

/**
 * Score every candidate, sort descending, and pick the top non-zero product.
 * Zero-scored (hard-constraint) rows stay in `ranked` for transparency.
 */
export function rankProducts(
  candidates: ProductWithAttributes[],
  intent: StructuredIntent,
): RankResult {
  const ranked = candidates
    .map((product) => ({ product, ...scoreProduct(product, intent) }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.product.name.localeCompare(b.product.name);
    });

  const selected = ranked.find((candidate) => candidate.score > 0) ?? null;
  return { ranked, selected };
}
