import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMOutputError } from "../src/lib/llm-provider";
import { MockLLMProvider } from "../src/lib/providers/mock-provider";
import { assertOpenAIStructuredSchema } from "../src/lib/providers/real-provider";
import {
  buildIntentPrompt,
  DEMO_INTENT_PHRASE,
  extractIntent,
  INJECTION_ATTEMPT_PHRASE,
} from "../src/modules/intent/intent-agent";
import {
  IntentBudgetError,
  IntentExtractionError,
  IntentPromptError,
  MAX_PLAUSIBLE_BUDGET,
  llmIntentSchema,
  normalizeCategory,
  type LlmIntent,
} from "../src/modules/intent/intent.schema";

const demoLlmIntent: LlmIntent = {
  category: "running_shoes",
  budget: 5000,
  currency: "INR",
  purpose: "running shoes",
  usage: "run around 25 km every week",
  priority: "best",
  purchaseMode: "autonomous",
  hasAdditionalUnparsedRequest: false,
};

function mockFor(text: string, payload: LlmIntent): MockLLMProvider {
  return new MockLLMProvider({
    fixtures: { [buildIntentPrompt(text)]: payload },
  });
}

describe("normalizeCategory", () => {
  it("maps running-shoe phrasing onto the seeded Sports catalog category", () => {
    expect(normalizeCategory("running_shoes")).toMatchObject({
      category: "Sports",
      match: "normalized",
    });
    expect(normalizeCategory("Sports").match).toBe("exact");
    expect(normalizeCategory("glow-in-the-dark moss").match).toBe("unrecognized");
    expect(normalizeCategory("glow-in-the-dark moss").confidence).toBeLessThan(0.5);
  });

  it("is representable in OpenAI structured-output mode", () => {
    expect(() => assertOpenAIStructuredSchema(llmIntentSchema)).not.toThrow();
  });
});

describe("extractIntent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("produces the PRD demo structure for the exact demo phrase", async () => {
    const result = await extractIntent(DEMO_INTENT_PHRASE, mockFor(DEMO_INTENT_PHRASE, demoLlmIntent));

    expect(result).toMatchObject({
      category: "Sports",
      extractedCategory: "running_shoes",
      categoryMatch: "normalized",
      budget: 5000,
      currency: "INR",
      purpose: "running shoes",
      usage: "run around 25 km every week",
      priority: "best",
      purchaseMode: "autonomous",
      hasAdditionalUnparsedRequest: false,
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("returns lower confidence for an unrecognized category rather than guessing a catalog bucket", async () => {
    const text = "I want a jar of glow moss under ₹2000";
    const result = await extractIntent(
      text,
      mockFor(text, {
        category: "glow moss",
        budget: 2000,
        currency: "INR",
        purpose: "glow moss",
        usage: null,
        priority: null,
        purchaseMode: "manual",
        hasAdditionalUnparsedRequest: false,
      }),
    );

    expect(result.category).toBe("glow moss");
    expect(["Electronics", "Sports", "Travel"]).not.toContain(result.category);
    expect(result.categoryMatch).toBe("unrecognized");
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.purchaseMode).toBe("manual");
  });

  it("rejects an injection payload that tries to set an unbounded budget", async () => {
    const tricked: LlmIntent = {
      category: "Sports",
      budget: 9_007_199_254_740_991,
      currency: "INR",
      purpose: "running shoes",
      usage: null,
      priority: null,
      purchaseMode: "autonomous",
      hasAdditionalUnparsedRequest: false,
    };

    await expect(extractIntent(INJECTION_ATTEMPT_PHRASE, mockFor(INJECTION_ATTEMPT_PHRASE, tricked))).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(IntentBudgetError);
        expect((err as IntentBudgetError).budget).toBeGreaterThan(MAX_PLAUSIBLE_BUDGET);
        expect(Number.isFinite((err as IntentBudgetError).budget)).toBe(true);
        return true;
      },
    );
  });

  it("rejects a missing/zero budget from an injection that never stated a numeric amount", async () => {
    const noBudget: LlmIntent = {
      category: "Sports",
      budget: 0,
      currency: "INR",
      purpose: "running shoes",
      usage: null,
      priority: null,
      purchaseMode: "autonomous",
      hasAdditionalUnparsedRequest: false,
    };

    await expect(
      extractIntent(INJECTION_ATTEMPT_PHRASE, mockFor(INJECTION_ATTEMPT_PHRASE, noBudget)),
    ).rejects.toBeInstanceOf(IntentBudgetError);
  });

  it("rejects a non-enum purchaseMode from a tricked model via schema validation", async () => {
    const provider = new MockLLMProvider({
      fixtures: {
        [buildIntentPrompt(INJECTION_ATTEMPT_PHRASE)]: {
          category: "Sports",
          budget: 5000,
          currency: "INR",
          purpose: "running shoes",
          usage: null,
          priority: null,
          purchaseMode: "bypass_policy",
          hasAdditionalUnparsedRequest: false,
        },
      },
    });

    await expect(extractIntent(INJECTION_ATTEMPT_PHRASE, provider)).rejects.toBeInstanceOf(IntentExtractionError);
  });

  it("surfaces malformed LLM output as a typed catchable error with a user-facing message", async () => {
    const provider = new MockLLMProvider({
      rawByPrompt: {
        [buildIntentPrompt(DEMO_INTENT_PHRASE)]: ["not-json", "still-not-json"],
      },
    });

    await expect(extractIntent(DEMO_INTENT_PHRASE, provider)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(IntentExtractionError);
      expect((err as IntentExtractionError).userMessage).toMatch(/could you rephrase/i);
      expect((err as IntentExtractionError).cause).toBeInstanceOf(LLMOutputError);
      return true;
    });
    expect(provider.completeCalls).toHaveLength(2);
  });

  it("rejects empty text before any LLM completion is attempted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new MockLLMProvider({ fixtures: { hi: demoLlmIntent } });

    await expect(extractIntent("   ", provider)).rejects.toBeInstanceOf(IntentPromptError);
    expect(provider.completeCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flags a second product request without inventing a second intent", async () => {
    const text = "running shoes under ₹5000 and also a laptop under ₹90000";
    const result = await extractIntent(
      text,
      mockFor(text, {
        ...demoLlmIntent,
        hasAdditionalUnparsedRequest: true,
      }),
    );

    expect(result.hasAdditionalUnparsedRequest).toBe(true);
    expect(result.category).toBe("Sports");
    expect(result.budget).toBe(5000);
  });
});
