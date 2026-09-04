import {
  buildIntentPrompt,
  DEMO_INTENT_PHRASE,
  DEMO_LAPTOP_PHRASE,
  GLOW_MOSS_PHRASE,
  LOW_BUDGET_SPORTS_PHRASE,
} from "../../modules/intent/intent-prompt";

const shoeIntent = {
  category: "running_shoes",
  budget: 5000,
  currency: "INR",
  purpose: "running shoes",
  usage: "run around 25 km every week",
  priority: "best",
  purchaseMode: "autonomous",
  hasAdditionalUnparsedRequest: false,
};

const laptopIntent = {
  category: "laptop",
  budget: 120000,
  currency: "INR",
  purpose: "laptop",
  usage: null,
  priority: null,
  purchaseMode: "manual",
  hasAdditionalUnparsedRequest: false,
};

const lowBudgetSportsIntent = {
  category: "Sports",
  budget: 50,
  currency: "INR",
  purpose: "running shoes",
  usage: null,
  priority: null,
  purchaseMode: "manual",
  hasAdditionalUnparsedRequest: false,
};

const glowMossIntent = {
  category: "glow moss",
  budget: 2000,
  currency: "INR",
  purpose: "glow moss",
  usage: null,
  priority: null,
  purchaseMode: "manual",
  hasAdditionalUnparsedRequest: false,
};

/** Common freeform aliases so local mock mode is usable without an OpenAI key. */
const SHOE_ALIASES = [
  DEMO_INTENT_PHRASE,
  "I need a running shoes under 5000",
  "I need running shoes under 5000",
  "I need running shoes under ₹5000",
  "I need running shoes under ₹5,000",
  "I need a running shoes under ₹5,000",
];

const LAPTOP_ALIASES = [
  DEMO_LAPTOP_PHRASE,
  "Buy me a laptop for 120000",
  "Buy me a laptop for ₹120000",
  "Buy me a laptop for ₹1,20,000",
];

function registerPhrases(
  out: Record<string, unknown>,
  phrases: string[],
  payload: Record<string, unknown>,
): void {
  for (const phrase of phrases) {
    out[buildIntentPrompt(phrase)] = payload;
  }
}

/** Deterministic structured-intent payloads for LLM_PROVIDER=mock (non-vitest). */
export function demoIntentFixtures(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  registerPhrases(out, SHOE_ALIASES, shoeIntent);
  registerPhrases(out, LAPTOP_ALIASES, laptopIntent);
  registerPhrases(out, [LOW_BUDGET_SPORTS_PHRASE], lowBudgetSportsIntent);
  registerPhrases(out, [GLOW_MOSS_PHRASE], glowMossIntent);
  return out;
}
