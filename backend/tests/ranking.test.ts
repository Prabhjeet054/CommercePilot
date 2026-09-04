import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { MockLLMProvider } from "../src/lib/providers/mock-provider";
import {
  DEMO_SHOE_PRICE,
  DEMO_SHOE_PRODUCT_ID,
} from "../src/modules/catalog/catalog.constants";
import type { StructuredIntent } from "../src/modules/intent/intent.schema";
import {
  buildExplainPrompt,
  explainTopPick,
  ExplanationUngroundedError,
  numericTokens,
} from "../src/modules/ranking/explain";
import { rankProducts } from "../src/modules/ranking/rank";
import {
  RANKING_WEIGHTS,
  scoreProduct,
  type ProductWithAttributes,
  type RankingFactor,
} from "../src/modules/ranking/score";
import { seedCatalog } from "../prisma/seed";

const demoIntent: StructuredIntent = {
  category: "Sports",
  extractedCategory: "running_shoes",
  categoryMatch: "normalized",
  budget: 5000,
  currency: "INR",
  purpose: "running shoes",
  usage: "run around 25 km every week",
  priority: "best",
  purchaseMode: "autonomous",
  confidence: 0.82,
  hasAdditionalUnparsedRequest: false,
};

function product(overrides: Partial<ProductWithAttributes> & Pick<ProductWithAttributes, "id" | "name">): ProductWithAttributes {
  return {
    category: "Sports",
    price: 4499,
    stock: 10,
    rating: 4.7,
    reviewCount: 1284,
    tags: ["cushioning", "distance", "trail", "running"],
    merchant: { name: "Apex Sports", trustScore: 92.5 },
    attributes: [
      { attrKey: "use", attrValue: "running" },
      { attrKey: "weekly_distance", attrValue: "25km" },
      { attrKey: "cushioning", attrValue: "high" },
    ],
    ...overrides,
  };
}

const strideRunner = product({
  id: "shoe",
  name: "Apex Stride Runner",
  price: 4499,
});

const tempoRacer = product({
  id: "tempo",
  name: "Apex Tempo Racer",
  price: 3999,
  rating: 4.4,
  reviewCount: 220,
  tags: ["running", "tempo", "light"],
  attributes: [
    { attrKey: "use", attrValue: "running" },
    { attrKey: "cushioning", attrValue: "low" },
  ],
});

const cityRunners = product({
  id: "city",
  name: "Bazaar City Runners",
  price: 1799,
  rating: 3.7,
  reviewCount: 90,
  tags: ["running", "budget", "road"],
  merchant: { name: "Budget Bazaar", trustScore: 41.25 },
  attributes: [
    { attrKey: "use", attrValue: "running" },
    { attrKey: "cushioning", attrValue: "low" },
  ],
});

const yogaMat = product({
  id: "yoga",
  name: "Apex Yoga Mat Pro",
  price: 1299,
  rating: 4.3,
  reviewCount: 860,
  tags: ["yoga", "studio", "mat"],
  attributes: [{ attrKey: "thickness_mm", attrValue: "6" }],
});

const trailGrit = product({
  id: "trail",
  name: "Apex Trail Grit",
  price: 5299,
  rating: 4.5,
  reviewCount: 410,
  tags: ["trail", "grip", "running"],
  attributes: [{ attrKey: "use", attrValue: "running" }],
});

const carbonElite = product({
  id: "carbon",
  name: "Apex Carbon Plate Elite",
  price: 18999,
  stock: 0,
  rating: 4.8,
  reviewCount: 96,
  tags: ["running", "race", "carbon"],
  attributes: [{ attrKey: "use", attrValue: "running" }],
});

describe("scoreProduct", () => {
  it("matches a hand-calculated Section 15 weighted sum on a synthetic product", () => {
    const intent: StructuredIntent = {
      ...demoIntent,
      category: "Electronics",
      extractedCategory: "gadget",
      purpose: "gadget",
      usage: undefined,
      priority: undefined,
      budget: 10_000,
    };
    const gadget = product({
      id: "gadget",
      name: "Gadget",
      category: "Electronics",
      price: 9000,
      stock: 5,
      rating: 5,
      reviewCount: 9,
      tags: ["gadget"],
      merchant: { name: "Nova Electronics", trustScore: 80 },
      attributes: [],
    });

    // priceFit: ideal = 0.9 * 10000 = 9000 → 100 * (1 - 0) = 100
    const priceFit = 100;
    // preferenceMatch: intent tokens {electronics, gadget} all present on the product → 100
    const preferenceMatch = 100;
    // quality: (5/5) * 100 * log10(1+9) / log10(1+1000)
    const quality = Number(((5 / 5) * 100 * (Math.log10(1 + 9) / Math.log10(1 + 1000))).toFixed(2));
    // specMatch: intent has no running/distance constraints → neutral 50
    const specMatch = 50;
    // merchantTrust: 80
    const merchantTrust = 80;
    const expected = Number(
      (0.3 * priceFit + 0.25 * preferenceMatch + 0.2 * quality + 0.15 * specMatch + 0.1 * merchantTrust).toFixed(2),
    );

    const result = scoreProduct(gadget, intent);
    const byName = Object.fromEntries(result.factors.map((factor) => [factor.name, factor.score]));
    expect(quality).toBe(33.33);
    expect(expected).toBe(77.17);
    expect(byName.priceFit).toBe(priceFit);
    expect(byName.preferenceMatch).toBe(preferenceMatch);
    expect(byName.quality).toBe(quality);
    expect(byName.specMatch).toBe(specMatch);
    expect(byName.merchantTrust).toBe(merchantTrust);
    expect(result.score).toBe(expected);
    expect(result.score).toBe(77.17);
  });

  it("applies the PRD Section 15 weights when no hard constraint fires", () => {
    const result = scoreProduct(strideRunner, demoIntent);
    const expected = Number(
      result.factors.reduce((sum, factor) => sum + factor.weight * factor.score, 0).toFixed(2),
    );
    expect(result.score).toBe(expected);
    expect(result.factors.map((factor) => factor.name)).toEqual([
      "priceFit",
      "preferenceMatch",
      "quality",
      "specMatch",
      "merchantTrust",
    ]);
    expect(result.factors.map((factor) => factor.weight)).toEqual([
      RANKING_WEIGHTS.priceFit,
      RANKING_WEIGHTS.preferenceMatch,
      RANKING_WEIGHTS.quality,
      RANKING_WEIGHTS.specMatch,
      RANKING_WEIGHTS.merchantTrust,
    ]);
    expect(result.factors[0]?.evidence).toMatch(/₹4,499 is within your ₹5,000 budget/);
  });

  it("hard-zeros an over-budget product even if other factors are strong", () => {
    const result = scoreProduct(trailGrit, demoIntent);
    expect(result.score).toBe(0);
    expect(result.factors[0]?.evidence).toMatch(/exceeds your ₹5,000 budget/);

    const otherwisePerfect = product({
      id: "over",
      name: "Perfect But Over Budget",
      price: 5000.01,
      rating: 5,
      reviewCount: 9000,
      merchant: { name: "Apex Sports", trustScore: 100 },
    });
    const perfect = scoreProduct(otherwisePerfect, demoIntent);
    expect(perfect.score).toBe(0);
    expect(perfect.factors.find((factor) => factor.name === "merchantTrust")?.score).toBe(100);
  });

  it("hard-zeros an out-of-stock product", () => {
    const inBudgetButEmpty = product({
      id: "empty",
      name: "Sold Out Runner",
      price: 3000,
      stock: 0,
    });
    expect(scoreProduct(inBudgetButEmpty, demoIntent).score).toBe(0);
    expect(scoreProduct(carbonElite, demoIntent).score).toBe(0);
  });

  it("does not hard-zero a product priced exactly at the budget ceiling", () => {
    const atCeiling = product({ id: "ceiling", name: "Ceiling Shoe", price: 5000 });
    const result = scoreProduct(atCeiling, demoIntent);
    expect(result.score).toBeGreaterThan(0);
    expect(result.factors[0]?.evidence).toMatch(/is within your ₹5,000 budget/);
  });

  it("treats a missing rating and zero reviews as a low quality score instead of throwing", () => {
    const sparse = product({
      id: "sparse",
      name: "Unrated Shoe",
      rating: null,
      reviewCount: 0,
    });
    const result = scoreProduct(sparse, demoIntent);
    expect(result.score).toBeGreaterThan(0);
    const quality = result.factors.find((factor) => factor.name === "quality");
    expect(quality?.score).toBe(0);
    expect(quality?.evidence).toMatch(/Missing rating/);
  });
});

describe("rankProducts", () => {
  it("returns an empty ranked list for an empty candidate set", () => {
    expect(rankProducts([], demoIntent)).toEqual({ ranked: [], selected: null });
  });

  it("ranks the ₹4,499 running shoe first among Sports candidates under ₹5,000", () => {
    const { ranked, selected } = rankProducts(
      [yogaMat, cityRunners, trailGrit, tempoRacer, carbonElite, strideRunner],
      demoIntent,
    );

    expect(selected?.product.id).toBe("shoe");
    expect(selected?.product.name).toBe("Apex Stride Runner");
    expect(ranked[0]?.product.id).toBe("shoe");
    expect(ranked.slice(0, 3).map((row) => row.product.name)).toEqual([
      "Apex Stride Runner",
      "Apex Tempo Racer",
      "Bazaar City Runners",
    ]);
    expect(ranked.find((row) => row.product.id === "trail")?.score).toBe(0);
    expect(ranked.find((row) => row.product.id === "carbon")?.score).toBe(0);
    expect(ranked.some((row) => row.score === 0)).toBe(true);
  });
});

describe("rankProducts against the seeded catalog", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("selects the ₹4,499 Apex Stride Runner as the top pick for the demo intent", async () => {
    const rows = await prisma.product.findMany({
      include: { merchant: true, attributes: true },
    });
    expect(rows.length).toBeGreaterThan(40);

    const candidates: ProductWithAttributes[] = rows.map((row) => ({
      id: row.id,
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

    const { ranked, selected } = rankProducts(candidates, demoIntent);
    const matching = ranked.filter(
      (row) => row.score > 0 && row.product.category === "Sports" && Number(row.product.price.toString()) <= 5000,
    );

    expect(selected?.product.id).toBe(DEMO_SHOE_PRODUCT_ID);
    expect(selected?.product.name).toBe("Apex Stride Runner");
    expect(Number(selected?.product.price.toString())).toBe(Number(DEMO_SHOE_PRICE));
    expect(matching[0]?.product.id).toBe(DEMO_SHOE_PRODUCT_ID);
    expect(ranked.find((row) => row.product.name === "Nova Ultrabook 16")?.score).toBe(0);
  });
});

describe("explainTopPick", () => {
  const factors: RankingFactor[] = [
    {
      name: "priceFit",
      score: 99.98,
      weight: 0.3,
      evidence: "₹4,499 is within your ₹5,000 budget (ideal ₹4,500)",
    },
    {
      name: "quality",
      score: 94.12,
      weight: 0.2,
      evidence: "Rating 4.7/5 from 1284 reviews",
    },
  ];

  it("only uses numeric tokens that already appear in the factor input", async () => {
    const explanation =
      "₹4,499 is within your ₹5,000 budget, backed by a 4.7/5 rating from 1284 reviews.";
    const provider = new MockLLMProvider({
      fixtures: { [buildExplainPrompt(factors)]: { explanation } },
    });

    await expect(explainTopPick(factors, provider)).resolves.toBe(explanation);

    const allowed = new Set(numericTokens(JSON.stringify(factors)));
    const observed = new Set(numericTokens(explanation));
    expect(observed.size).toBeGreaterThan(0);
    for (const token of observed) {
      expect(allowed.has(token), `ungrounded number ${token}`).toBe(true);
    }
  });

  it("rejects narration that invents a number not present in the factors", async () => {
    const provider = new MockLLMProvider({
      fixtures: {
        [buildExplainPrompt(factors)]: {
          explanation: "This 999999 rupee pick is a secret deal at 12 percent off, rated 4.71.",
        },
      },
    });

    await expect(explainTopPick(factors, provider)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ExplanationUngroundedError);
      const invented = (err as ExplanationUngroundedError).invented;
      expect(invented).toEqual(expect.arrayContaining(["999999", "12", "4.71"]));
      expect(invented).not.toContain("4499");
      return true;
    });
  });
});
