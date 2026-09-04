import type { StructuredIntent } from "../intent/intent.schema";

export const RANKING_WEIGHTS = {
  priceFit: 0.3,
  preferenceMatch: 0.25,
  quality: 0.2,
  specMatch: 0.15,
  merchantTrust: 0.1,
} as const;

export type RankingFactorName = keyof typeof RANKING_WEIGHTS;

export type RankingFactor = {
  name: RankingFactorName;
  score: number;
  weight: number;
  evidence: string;
};

export type ProductAttributeView = {
  attrKey: string;
  attrValue: string | null;
};

export type ProductWithAttributes = {
  id: string;
  name: string;
  category: string;
  price: { toString(): string } | number | string;
  stock: number;
  rating: { toString(): string } | number | string | null;
  reviewCount: number;
  tags: string[];
  merchant: {
    name: string;
    trustScore: { toString(): string } | number | string;
  };
  attributes: ProductAttributeView[];
};

export type ProductScore = {
  score: number;
  factors: RankingFactor[];
};

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "i",
  "me",
  "my",
  "we",
  "you",
  "it",
  "is",
  "be",
  "need",
  "want",
  "under",
  "around",
  "every",
  "option",
  "automatically",
]);

function rupees(value: { toString(): string } | number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value.toString());
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatInr(amount: number): string {
  return amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function roundScore(value: number): number {
  return Number(clamp(value, 0, 100).toFixed(2));
}

function splitIdent(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function expandTokens(tokens: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const token of tokens) {
    out.add(token);
    if (token === "run" || token === "runner" || token === "running") {
      out.add("run");
      out.add("running");
      out.add("runner");
    }
    if (token === "shoe" || token === "shoes") {
      out.add("shoe");
      out.add("shoes");
    }
    if (token === "week" || token === "weekly") {
      out.add("week");
      out.add("weekly");
    }
  }
  return out;
}

function intentTokens(intent: StructuredIntent): Set<string> {
  return expandTokens(
    [
      ...splitIdent(intent.category),
      ...splitIdent(intent.extractedCategory),
      ...splitIdent(intent.purpose),
      ...splitIdent(intent.usage ?? ""),
      ...splitIdent(intent.priority ?? ""),
    ],
  );
}

function productTokens(product: ProductWithAttributes): Set<string> {
  const parts = [
    product.category,
    product.name,
    ...product.tags,
    ...product.attributes.flatMap((attribute) => [attribute.attrKey, attribute.attrValue ?? ""]),
  ];
  return expandTokens(parts.flatMap(splitIdent));
}

function attrValue(product: ProductWithAttributes, key: string): string {
  const found = product.attributes.find((attribute) => attribute.attrKey.toLowerCase() === key);
  return (found?.attrValue ?? "").toLowerCase();
}

function intentBlob(intent: StructuredIntent): string {
  return [intent.category, intent.extractedCategory, intent.purpose, intent.usage, intent.priority]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function priceFit(price: number, budget: number): { score: number; evidence: string } {
  if (!(budget > 0)) {
    return { score: 0, evidence: `Budget ₹${formatInr(budget)} is not usable for price fit` };
  }
  const ideal = Number((budget * 0.9).toFixed(2));
  const score = roundScore(100 * (1 - Math.abs(price - ideal) / budget));
  if (price > budget) {
    return {
      score,
      evidence: `₹${formatInr(price)} exceeds your ₹${formatInr(budget)} budget (hard constraint)`,
    };
  }
  return {
    score,
    evidence: `₹${formatInr(price)} is within your ₹${formatInr(budget)} budget (ideal ₹${formatInr(ideal)})`,
  };
}

function preferenceMatch(
  product: ProductWithAttributes,
  intent: StructuredIntent,
): { score: number; evidence: string } {
  const wanted = intentTokens(intent);
  if (wanted.size === 0) {
    return { score: 50, evidence: "No intent tokens to match; using a neutral preference score of 50" };
  }
  const have = productTokens(product);
  let hits = 0;
  for (const token of wanted) {
    if (have.has(token)) {
      hits += 1;
    }
  }
  const score = roundScore((100 * hits) / wanted.size);
  return {
    score,
    evidence: `${hits} of ${wanted.size} intent tokens overlap with ${product.name} tags and specs`,
  };
}

function qualityScore(product: ProductWithAttributes): { score: number; evidence: string } {
  const rating = rupees(product.rating);
  const reviews = Number.isFinite(product.reviewCount) && product.reviewCount > 0 ? product.reviewCount : 0;
  const safeRating = rating === null ? 1 : clamp(rating, 0, 5);
  const volume = Math.log10(1 + reviews) / Math.log10(1 + 1000);
  const score = roundScore((safeRating / 5) * 100 * volume);
  if (rating === null) {
    return {
      score,
      evidence: `Missing rating treated as ${safeRating}/5 with ${reviews} reviews`,
    };
  }
  return {
    score,
    evidence: `Rating ${safeRating}/5 from ${reviews} reviews`,
  };
}

function specMatch(
  product: ProductWithAttributes,
  intent: StructuredIntent,
): { score: number; evidence: string } {
  const blob = intentBlob(intent);
  const checks: Array<{ ok: boolean; label: string }> = [];

  if (/\brun|\brunning|\bshoe/.test(blob)) {
    const use = attrValue(product, "use");
    const ok = use.includes("running") || productTokens(product).has("running");
    checks.push({ ok, label: "running use" });
  }
  if (/\b\d+\s*km\b|\bdistance\b|\bweekly\b/.test(blob)) {
    const weekly = attrValue(product, "weekly_distance");
    const cushion = attrValue(product, "cushioning");
    const ok =
      weekly.length > 0 ||
      productTokens(product).has("distance") ||
      cushion === "high" ||
      cushion === "medium";
    checks.push({ ok, label: "distance/cushioning" });
  }

  if (checks.length === 0) {
    return { score: 50, evidence: "No numeric spec constraints in the intent; using a neutral spec score of 50" };
  }
  const passed = checks.filter((check) => check.ok).length;
  return {
    score: roundScore((100 * passed) / checks.length),
    evidence: `${passed} of ${checks.length} spec checks matched (${checks.map((check) => check.label).join(", ")})`,
  };
}

function merchantTrust(product: ProductWithAttributes): { score: number; evidence: string } {
  const trust = rupees(product.merchant.trustScore);
  const score = roundScore(trust === null ? 50 : clamp(trust, 0, 100));
  return {
    score,
    evidence: `${product.merchant.name} trust score ${score}`,
  };
}

/**
 * Deterministic ranking score (PRD Section 15). Weights are fixed.
 * Hard constraints zero the total when price > budget or stock <= 0.
 */
export function scoreProduct(product: ProductWithAttributes, intent: StructuredIntent): ProductScore {
  const price = rupees(product.price) ?? Number.POSITIVE_INFINITY;
  const budget = intent.budget;
  const overBudget = price > budget;
  const outOfStock = !Number.isFinite(product.stock) || product.stock <= 0;

  const computed = {
    priceFit: priceFit(Number.isFinite(price) ? price : 0, budget),
    preferenceMatch: preferenceMatch(product, intent),
    quality: qualityScore(product),
    specMatch: specMatch(product, intent),
    merchantTrust: merchantTrust(product),
  };

  const factors: RankingFactor[] = (Object.keys(RANKING_WEIGHTS) as RankingFactorName[]).map((name) => ({
    name,
    score: computed[name].score,
    weight: RANKING_WEIGHTS[name],
    evidence: computed[name].evidence,
  }));

  if (overBudget || outOfStock) {
    return { score: 0, factors };
  }

  const weighted = factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0);
  return { score: roundScore(weighted), factors };
}
