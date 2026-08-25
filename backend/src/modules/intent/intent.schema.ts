import { z } from "zod";
import { CATALOG_CATEGORIES, type CatalogCategory } from "../catalog/catalog.constants";

/** Hard cap so "unlimited" / injection payloads cannot become an unbounded number. */
export const MAX_PLAUSIBLE_BUDGET = 10_000_000;

export const PURCHASE_MODES = ["autonomous", "manual"] as const;
export type PurchaseMode = (typeof PURCHASE_MODES)[number];

/**
 * Schema passed to the LLM provider. Optional facts are `.nullable()` so OpenAI
 * structured output can represent them; budget bounds are enforced after parse
 * with a typed error (not silent coercion).
 */
export const llmIntentSchema = z.object({
  category: z.string().min(1).max(80),
  budget: z.number(),
  currency: z.string().min(1).max(16),
  purpose: z.string().min(1).max(500),
  usage: z.string().max(500).nullish(),
  priority: z.string().max(80).nullish(),
  purchaseMode: z.enum(PURCHASE_MODES),
  hasAdditionalUnparsedRequest: z.boolean(),
});

export type LlmIntent = z.infer<typeof llmIntentSchema>;

export type CategoryMatch = "exact" | "normalized" | "unrecognized";

export type StructuredIntent = {
  category: string;
  extractedCategory: string;
  categoryMatch: CategoryMatch;
  budget: number;
  currency: string;
  purpose: string;
  usage?: string;
  priority?: string;
  purchaseMode: PurchaseMode;
  confidence: number;
  hasAdditionalUnparsedRequest: boolean;
};

export class IntentPromptError extends Error {
  readonly userMessage = "Please describe what you want to buy.";

  constructor(message: string) {
    super(message);
    this.name = "IntentPromptError";
  }
}

export class IntentBudgetError extends Error {
  readonly userMessage =
    "I need a positive budget I can actually use. Unlimited or missing amounts are not allowed.";
  readonly budget: number;

  constructor(message: string, budget: number) {
    super(message);
    this.name = "IntentBudgetError";
    this.budget = budget;
  }
}

export class IntentExtractionError extends Error {
  readonly userMessage = "I couldn't understand that request, could you rephrase?";
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "IntentExtractionError";
    this.cause = cause;
  }
}

const CATEGORY_ALIASES: Record<string, CatalogCategory> = {
  sports: "Sports",
  sport: "Sports",
  running: "Sports",
  runner: "Sports",
  shoes: "Sports",
  shoe: "Sports",
  footwear: "Sports",
  athletic: "Sports",
  athletics: "Sports",
  trail: "Sports",
  gym: "Sports",
  fitness: "Sports",
  running_shoes: "Sports",
  runningshoes: "Sports",
  electronics: "Electronics",
  electronic: "Electronics",
  gadget: "Electronics",
  gadgets: "Electronics",
  laptop: "Electronics",
  laptops: "Electronics",
  phone: "Electronics",
  phones: "Electronics",
  headphone: "Electronics",
  headphones: "Electronics",
  travel: "Travel",
  luggage: "Travel",
  suitcase: "Travel",
  flight: "Travel",
  hotel: "Travel",
  trip: "Travel",
};

function fold(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function compact(value: string): string {
  return fold(value).replace(/\s+/g, "");
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i]![0] = i;
  for (let j = 0; j < cols; j += 1) dp[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}

export function normalizeCategory(raw: string): {
  category: string;
  match: CategoryMatch;
  confidence: number;
} {
  const extracted = raw.trim();
  if (extracted.length === 0) {
    return { category: extracted, match: "unrecognized", confidence: 0.2 };
  }

  const folded = fold(extracted);
  const squeezed = compact(extracted);

  for (const known of CATALOG_CATEGORIES) {
    if (fold(known) === folded) {
      return { category: known, match: "exact", confidence: 0.95 };
    }
  }

  const alias = CATEGORY_ALIASES[folded] ?? CATEGORY_ALIASES[squeezed];
  if (alias) {
    return { category: alias, match: "normalized", confidence: 0.82 };
  }

  for (const [token, mapped] of Object.entries(CATEGORY_ALIASES)) {
    if (token.length >= 4 && (folded.includes(token) || token.includes(folded))) {
      return { category: mapped, match: "normalized", confidence: 0.8 };
    }
  }

  let best: { category: CatalogCategory; distance: number } | null = null;
  for (const known of CATALOG_CATEGORIES) {
    const distance = editDistance(squeezed, compact(known));
    if (!best || distance < best.distance) {
      best = { category: known, distance };
    }
  }
  if (best && squeezed.length >= 4 && best.distance <= 2) {
    return { category: best.category, match: "normalized", confidence: 0.72 };
  }

  return { category: extracted, match: "unrecognized", confidence: 0.35 };
}

export function normalizeCurrency(raw: string): string {
  const folded = fold(raw).replace(/\s+/g, "");
  if (
    folded === "inr" ||
    folded === "rs" ||
    folded === "rupee" ||
    folded === "rupees" ||
    raw.includes("₹")
  ) {
    return "INR";
  }
  const letters = raw.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(letters)) {
    return letters;
  }
  return "INR";
}

export function assertPlausibleBudget(budget: number): void {
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new IntentBudgetError(
      `Budget must be a finite amount greater than 0, received ${String(budget)}`,
      budget,
    );
  }
  if (budget > MAX_PLAUSIBLE_BUDGET) {
    throw new IntentBudgetError(
      `Budget ${budget} exceeds the plausible maximum of ₹${MAX_PLAUSIBLE_BUDGET.toLocaleString("en-IN")}`,
      budget,
    );
  }
}

export function toStructuredIntent(extracted: LlmIntent): StructuredIntent {
  assertPlausibleBudget(extracted.budget);
  const normalized = normalizeCategory(extracted.category);
  const confidence = Math.max(
    0.15,
    Math.min(0.99, normalized.confidence - (extracted.hasAdditionalUnparsedRequest ? 0.05 : 0)),
  );

  return {
    category: normalized.category,
    extractedCategory: extracted.category.trim(),
    categoryMatch: normalized.match,
    budget: Number(extracted.budget.toFixed(2)),
    currency: normalizeCurrency(extracted.currency),
    purpose: extracted.purpose.trim(),
    usage: extracted.usage?.trim() || undefined,
    priority: extracted.priority?.trim() || undefined,
    purchaseMode: extracted.purchaseMode,
    confidence,
    hasAdditionalUnparsedRequest: extracted.hasAdditionalUnparsedRequest,
  };
}
