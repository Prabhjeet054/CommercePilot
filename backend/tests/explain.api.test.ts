import { randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { setLLMProviderForTests } from "../src/lib/get-llm-provider";
import { prisma } from "../src/lib/prisma";
import { MockLLMProvider } from "../src/lib/providers/mock-provider";
import { DEMO_SHOE_PRODUCT_ID } from "../src/modules/catalog/catalog.constants";
import { buildIntentPrompt } from "../src/modules/intent/intent-agent";
import type { LlmIntent } from "../src/modules/intent/intent.schema";
import { INITIAL_INTENT_STATE } from "../src/lib/state-machine";
import {
  assertExplanationGrounded,
  explainPurchaseIntent,
} from "../src/modules/ranking/explain-endpoint";
import { numericTokens } from "../src/modules/ranking/explain";
import { DEMO_LAPTOP_PHRASE } from "../src/modules/orchestrator/purchase-intent";
import { seedCatalog } from "../prisma/seed";

const JWT_SECRET = "explain-api-access-secret";
const JWT_REFRESH_SECRET = "explain-api-refresh-secret";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

const SHOE_PHRASE =
  "I need running shoes under ₹5,000. I run around 25 km every week. Buy the best option automatically.";

const demoShoeLlm: LlmIntent = {
  category: "running_shoes",
  budget: 5000,
  currency: "INR",
  purpose: "running shoes",
  usage: "run around 25 km every week",
  priority: "best",
  purchaseMode: "autonomous",
  hasAdditionalUnparsedRequest: false,
};

const demoLaptopLlm: LlmIntent = {
  category: "laptop",
  budget: 120000,
  currency: "INR",
  purpose: "laptop",
  usage: null,
  priority: null,
  purchaseMode: "manual",
  hasAdditionalUnparsedRequest: false,
};

const DEMO_POLICY = {
  maxAutonomousAmount: 5000,
  dailySpendingLimit: 10000,
  approvalThreshold: 5000,
  allowedCategories: ["Electronics", "Sports", "Travel"],
  blockedCategories: [] as string[],
  trustedMerchants: [] as string[],
  autonomousEnabled: true,
  maxAutonomousTxnsPerDay: 3,
};

function clientIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
}

function normalizeToken(token: string): string {
  if (!token.includes(".")) {
    return token;
  }
  return token.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** Every explanation number must match a DB-sourced token (with trailing-zero normalization). */
function assertAllNumbersTraceableToDb(explanation: string, dbSource: unknown): void {
  const observed = numericTokens(explanation);
  // Policy-only copy may contain no digits; that is still "grounded" (nothing invented).
  if (observed.length === 0) {
    return;
  }

  const allowedRaw = numericTokens(JSON.stringify(dbSource));
  const allowed = new Set(allowedRaw.flatMap((t) => [t, normalizeToken(t)]));

  for (const token of observed) {
    const ok = allowed.has(token) || allowed.has(normalizeToken(token));
    expect(ok, `ungrounded numeric token "${token}" not found in DB source`).toBe(true);
  }
}

async function registerCustomer() {
  const email = `explain-${randomUUID()}@example.com`;
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Explain User", role: "customer" });
  expect(response.status).toBe(201);
  return { email, token: response.body.accessToken as string, userId: response.body.user.id as string };
}

async function putPolicy(token: string, policy: Record<string, unknown> = DEMO_POLICY) {
  const response = await request(app)
    .post("/policies")
    .set("Authorization", `Bearer ${token}`)
    .send(policy);
  expect([200, 201]).toContain(response.status);
}

describe("Phase 21 explain validation", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  beforeEach(() => {
    setLLMProviderForTests(
      new MockLLMProvider({
        fixtures: {
          [buildIntentPrompt(SHOE_PHRASE)]: demoShoeLlm,
          [buildIntentPrompt(DEMO_LAPTOP_PHRASE)]: demoLaptopLlm,
        },
      }),
    );
  });

  afterEach(async () => {
    setLLMProviderForTests(null);
    await prisma.auditLog.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "explain-" } } } },
    });
    await prisma.approval.deleteMany({
      where: { user: { email: { startsWith: "explain-" } } },
    });
    await prisma.policyEvaluation.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "explain-" } } } },
    });
    await prisma.agentDecision.deleteMany({
      where: { agentRun: { purchaseIntent: { user: { email: { startsWith: "explain-" } } } } },
    });
    await prisma.agentRun.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "explain-" } } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "explain-" } } },
    });
    await prisma.financialPolicy.deleteMany({
      where: { user: { email: { startsWith: "explain-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "explain-" } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("shoe: every numeric token in explanation matches independently queried DB values", async () => {
    const { token, userId } = await registerCustomer();
    await putPolicy(token);

    const created = await request(app)
      .post("/purchase-intents")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: SHOE_PHRASE, purchaseMode: "autonomous" });
    expect(created.status).toBe(201);
    const intentId = created.body.id as string;

    const result = await explainPurchaseIntent(intentId, userId, {
      tryLlmNarration: async () => {
        throw new Error("skip llm — force template");
      },
    });

    // Independent DB read — not the API's groundedFields echo.
    const intent = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: intentId },
      include: {
        agentRun: {
          include: {
            decisions: {
              where: { selected: true },
              include: { product: true },
            },
          },
        },
        policyEvaluations: { orderBy: { evaluatedAt: "desc" }, take: 1 },
      },
    });
    const decision = intent.agentRun!.decisions[0]!;
    const evaluation = intent.policyEvaluations[0]!;
    const structured = intent.structuredIntent as { budget: number };
    const product = decision.product;

    expect(Number(product.price.toString())).toBe(4499);
    expect(structured.budget).toBe(5000);
    expect(evaluation.decision).toBe("ALLOW");
    expect(product.id).toBe(DEMO_SHOE_PRODUCT_ID);

    const dbSource = {
      price: product.price.toString(),
      budget: structured.budget,
      rating: product.rating?.toString() ?? null,
      reviewCount: product.reviewCount,
      decision: evaluation.decision,
      reasonCode: evaluation.reasonCode,
      scoreBreakdown: decision.scoreBreakdown,
      policySnapshot: evaluation.policySnapshot,
    };

    expect(result.explanation).toMatch(/4,499/);
    expect(result.explanation).toMatch(/5,000/);
    expect(result.explanation).toContain(String(Number(product.rating?.toString())));
    expect(result.explanation).toContain(String(product.reviewCount));
    expect(result.explanation).toContain("ALLOW");
    expect(numericTokens(result.explanation).length).toBeGreaterThan(0);

    assertAllNumbersTraceableToDb(result.explanation, dbSource);
    assertExplanationGrounded(result.explanation, result.groundedFields);

    const http = await request(app)
      .get(`/agent/decisions/${intentId}/explain`)
      .set("Authorization", `Bearer ${token}`);
    expect(http.status).toBe(200);
    // HTTP path may LLM-fallback; still every number must trace to the same DB source.
    assertAllNumbersTraceableToDb(http.body.explanation, dbSource);
    expect(http.body.explanation).not.toMatch(/999999|hallucin/);
  });

  it("laptop: every numeric token traces to policySnapshot threshold + reasonCode from DB", async () => {
    const { token } = await registerCustomer();
    await putPolicy(token, { ...DEMO_POLICY, dailySpendingLimit: 500000 });

    const created = await request(app)
      .post("/purchase-intents")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: DEMO_LAPTOP_PHRASE, purchaseMode: "manual" });
    expect(created.status).toBe(201);
    const intentId = created.body.id as string;

    const evaluation = await prisma.policyEvaluation.findFirstOrThrow({
      where: { purchaseIntentId: intentId },
      orderBy: { evaluatedAt: "desc" },
    });
    expect(evaluation.decision).toBe("REQUIRE_APPROVAL");
    expect(evaluation.reasonCode).toBe("AMOUNT_ABOVE_APPROVAL_THRESHOLD");
    const snapshot = evaluation.policySnapshot as {
      approvalThreshold: string;
      dailySpendingLimit: string;
      maxAutonomousAmount: string;
    };
    expect(snapshot.approvalThreshold).toBe("5000.00");

    const http = await request(app)
      .get(`/agent/decisions/${intentId}/explain`)
      .set("Authorization", `Bearer ${token}`);
    expect(http.status).toBe(200);
    expect(http.body.explanation).toContain("AMOUNT_ABOVE_APPROVAL_THRESHOLD");
    expect(http.body.explanation).toMatch(/5,000/);

    const dbSource = {
      decision: evaluation.decision,
      reasonCode: evaluation.reasonCode,
      policySnapshot: evaluation.policySnapshot,
    };
    assertAllNumbersTraceableToDb(http.body.explanation, dbSource);
    // The only money figure in the explanation must be the approval threshold.
    const tokens = numericTokens(http.body.explanation).map(normalizeToken);
    expect(tokens).toContain("5000");
    expect(tokens.every((t) => t === "5000")).toBe(true);
  });

  it("fallback: ungrounded LLM numbers are rejected; safe template is returned instead", async () => {
    const { token, userId } = await registerCustomer();
    await putPolicy(token);

    const created = await request(app)
      .post("/purchase-intents")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: SHOE_PHRASE, purchaseMode: "autonomous" });
    const intentId = created.body.id as string;

    const poisoned =
      "This 999999 rupee steal is 12 percent off with a mythical 9.9 rating.";
    const result = await explainPurchaseIntent(intentId, userId, {
      tryLlmNarration: async () => poisoned,
    });

    expect(result.source).toBe("llm_fallback_template");
    expect(result.explanation).not.toBe(poisoned);
    expect(result.explanation).not.toContain("999999");
    expect(result.explanation).not.toContain("9.9");
    expect(numericTokens(result.explanation)).not.toContain("12");
    expect(result.explanation).toContain("4,499");

    const decision = await prisma.agentDecision.findFirstOrThrow({
      where: { agentRun: { purchaseIntentId: intentId }, selected: true },
      include: { product: true },
    });
    const intent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intentId } });
    const evaluation = await prisma.policyEvaluation.findFirstOrThrow({
      where: { purchaseIntentId: intentId },
    });
    assertAllNumbersTraceableToDb(result.explanation, {
      price: decision.product.price.toString(),
      budget: (intent.structuredIntent as { budget: number }).budget,
      rating: decision.product.rating?.toString(),
      reviewCount: decision.product.reviewCount,
      scoreBreakdown: decision.scoreBreakdown,
      policySnapshot: evaluation.policySnapshot,
      decision: evaluation.decision,
      reasonCode: evaluation.reasonCode,
    });
  });

  it("not ready: intent with no agent_decisions returns 409 EXPLAIN_NOT_READY", async () => {
    const { token, userId } = await registerCustomer();
    const intent = await prisma.purchaseIntent.create({
      data: {
        userId,
        rawText: "still processing",
        structuredIntent: {},
        purchaseMode: "autonomous",
        status: INITIAL_INTENT_STATE,
        agentRun: { create: { status: "RUNNING" } },
      },
    });

    const decisions = await prisma.agentDecision.count({
      where: { agentRun: { purchaseIntentId: intent.id } },
    });
    expect(decisions).toBe(0);

    const http = await request(app)
      .get(`/agent/decisions/${intent.id}/explain`)
      .set("Authorization", `Bearer ${token}`);
    expect(http.status).toBe(409);
    expect(http.body.error).toBe("EXPLAIN_NOT_READY");
    expect(http.body.explanation).toBeUndefined();
  });

  it("IDOR: another customer's intent returns 404 (not 403)", async () => {
    const owner = await registerCustomer();
    await putPolicy(owner.token);
    const created = await request(app)
      .post("/purchase-intents")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ text: SHOE_PHRASE, purchaseMode: "autonomous" });
    expect(created.status).toBe(201);

    const other = await registerCustomer();
    const http = await request(app)
      .get(`/agent/decisions/${created.body.id}/explain`)
      .set("Authorization", `Bearer ${other.token}`);
    expect(http.status).toBe(404);
    expect(http.body.error).toBe("NOT_FOUND");
  });

  it("DENY uses policy-reason path without product sales pitch", async () => {
    const { token } = await registerCustomer();
    await putPolicy(token, { ...DEMO_POLICY, blockedCategories: ["Sports"] });

    const created = await request(app)
      .post("/purchase-intents")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: SHOE_PHRASE, purchaseMode: "autonomous" });
    expect(created.body.result).toBe("POLICY_DENIED");

    const evaluation = await prisma.policyEvaluation.findFirstOrThrow({
      where: { purchaseIntentId: created.body.id },
    });
    const http = await request(app)
      .get(`/agent/decisions/${created.body.id}/explain`)
      .set("Authorization", `Bearer ${token}`);
    expect(http.status).toBe(200);
    expect(http.body.explanation).toContain("CATEGORY_BLOCKED");
    expect(http.body.explanation.toLowerCase()).not.toMatch(/i selected/);
    assertAllNumbersTraceableToDb(http.body.explanation, {
      decision: evaluation.decision,
      reasonCode: evaluation.reasonCode,
      policySnapshot: evaluation.policySnapshot,
    });
  });
});
