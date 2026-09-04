import {
  buildIntentPrompt,
  DEMO_INTENT_PHRASE,
  DEMO_LAPTOP_PHRASE,
  GLOW_MOSS_PHRASE,
  LOW_BUDGET_SPORTS_PHRASE,
} from "../../modules/intent/intent-prompt";

/** Deterministic structured-intent payloads for LLM_PROVIDER=mock (non-vitest). */
export function demoIntentFixtures(): Record<string, unknown> {
  return {
    [buildIntentPrompt(DEMO_INTENT_PHRASE)]: {
      category: "running_shoes",
      budget: 5000,
      currency: "INR",
      purpose: "running shoes",
      usage: "run around 25 km every week",
      priority: "best",
      purchaseMode: "autonomous",
      hasAdditionalUnparsedRequest: false,
    },
    [buildIntentPrompt(DEMO_LAPTOP_PHRASE)]: {
      category: "laptop",
      budget: 120000,
      currency: "INR",
      purpose: "laptop",
      usage: null,
      priority: null,
      purchaseMode: "manual",
      hasAdditionalUnparsedRequest: false,
    },
    [buildIntentPrompt(LOW_BUDGET_SPORTS_PHRASE)]: {
      category: "Sports",
      budget: 50,
      currency: "INR",
      purpose: "running shoes",
      usage: null,
      priority: null,
      purchaseMode: "manual",
      hasAdditionalUnparsedRequest: false,
    },
    [buildIntentPrompt(GLOW_MOSS_PHRASE)]: {
      category: "glow moss",
      budget: 2000,
      currency: "INR",
      purpose: "glow moss",
      usage: null,
      priority: null,
      purchaseMode: "manual",
      hasAdditionalUnparsedRequest: false,
    },
  };
}
