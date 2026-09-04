import { randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { setLLMProviderForTests } from "../src/lib/get-llm-provider";
import { prisma } from "../src/lib/prisma";
import { MockLLMProvider } from "../src/lib/providers/mock-provider";
import {
  DEMO_LAPTOP_PRICE,
  DEMO_LAPTOP_PRODUCT_ID,
  DEMO_SHOE_PRICE,
  DEMO_SHOE_PRODUCT_ID,
} from "../src/modules/catalog/catalog.constants";
import { buildIntentPrompt, DEMO_INTENT_PHRASE } from "../src/modules/intent/intent-agent";
import type { LlmIntent } from "../src/modules/intent/intent.schema";
import { REASON } from "../src/modules/policy/evaluate";
import {
  buildPolicyProposal,
  DEMO_LAPTOP_PHRASE,
  PIPELINE_RESULT,
} from "../src/modules/orchestrator/purchase-intent";
import { seedCatalog } from "../prisma/seed";

const JWT_SECRET = "orchestrator-api-access-secret";
const JWT_REFRESH_SECRET = "orchestrator-api-refresh-secret";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

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

function uniqueEmail(prefix = "orchestrator-test"): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

function clientIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function installIntentFixtures(): void {
  setLLMProviderForTests(
    new MockLLMProvider({
      fixtures: {
        [buildIntentPrompt(DEMO_INTENT_PHRASE)]: demoShoeLlm,
        [buildIntentPrompt(DEMO_LAPTOP_PHRASE)]: demoLaptopLlm,
        [buildIntentPrompt("buy glow moss under ₹2000")]: {
          category: "glow moss",
          budget: 2000,
          currency: "INR",
          purpose: "glow moss",
          usage: null,
          priority: null,
          purchaseMode: "manual",
          hasAdditionalUnparsedRequest: false,
        } satisfies LlmIntent,
      },
    }),
  );
}

async function registerCustomer() {
  const email = uniqueEmail();
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Orchestrator User", role: "customer" });
  expect(response.status).toBe(201);
  return {
    email,
    token: response.body.accessToken as string,
    user: response.body.user as { id: string; role: string },
  };
}

async function registerMerchantAdmin() {
  const email = uniqueEmail("orchestrator-admin");
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Orchestrator Admin", role: "merchant_admin" });
  expect(response.status).toBe(201);
  return { token: response.body.accessToken as string };
}

async function putPolicy(token: string, policy: Record<string, unknown> = DEMO_POLICY) {
  const response = await request(app).post("/policies").set(authHeader(token)).send(policy);
  expect([200, 201]).toContain(response.status);
  return response.body;
}

describe("buildPolicyProposal", () => {
  it("uses the catalog product's stored price/category/merchant, not the LLM budget", () => {
    const proposal = buildPolicyProposal("user-1", {
      id: DEMO_SHOE_PRODUCT_ID,
      price: DEMO_SHOE_PRICE,
      category: "Sports",
      merchantId: "merchant-apex",
    });

    expect(proposal).toEqual({
      userId: "user-1",
      productId: DEMO_SHOE_PRODUCT_ID,
      amount: 4499,
      category: "Sports",
      merchantId: "merchant-apex",
    });
    expect(proposal.amount).not.toBe(5000);
  });
});

describe("POST /purchase-intents", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  afterEach(() => {
    setLLMProviderForTests(null);
  });

  afterAll(async () => {
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "orchestrator-test-" } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "orchestrator-admin-" } } },
    });
    await prisma.financialPolicy.deleteMany({
      where: { user: { email: { startsWith: "orchestrator-test-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "orchestrator-test-" } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: "orchestrator-admin-" } } });
    await prisma.$disconnect();
  });

  it("returns 401 without a bearer token", async () => {
    const response = await request(app)
      .post("/purchase-intents")
      .send({ text: DEMO_INTENT_PHRASE, purchaseMode: "autonomous" });
    expect(response.status).toBe(401);
  });

  it("returns 403 for a merchant_admin", async () => {
    installIntentFixtures();
    const admin = await registerMerchantAdmin();
    const response = await request(app)
      .post("/purchase-intents")
      .set(authHeader(admin.token))
      .send({ text: DEMO_INTENT_PHRASE, purchaseMode: "autonomous" });
    expect(response.status).toBe(403);
  });

  it("returns 400 when text or purchaseMode is missing", async () => {
    const customer = await registerCustomer();
    const response = await request(app)
      .post("/purchase-intents")
      .set(authHeader(customer.token))
      .send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
  });

  it("reproduces the PRD shoe demo: POLICY_ALLOWED and the ₹4,499 Apex Stride Runner", async () => {
    installIntentFixtures();
    const customer = await registerCustomer();
    await putPolicy(customer.token);

    const response = await request(app)
      .post("/purchase-intents")
      .set(authHeader(customer.token))
      .send({ text: DEMO_INTENT_PHRASE, purchaseMode: "autonomous" });

    expect(response.status).toBe(201);
    expect(response.body.result).toBe(PIPELINE_RESULT.POLICY_ALLOWED);
    expect(response.body.status).toBe("POLICY_ALLOWED");
    expect(response.body.selectedProduct.id).toBe(DEMO_SHOE_PRODUCT_ID);
    expect(response.body.selectedProduct.price).toBe(DEMO_SHOE_PRICE);
    expect(response.body.selectedProduct.category).toBe("Sports");
    expect(response.body.policyDecision.decision).toBe("ALLOW");
    expect(response.body.policyDecision.reasonCode).toBe(REASON.WITHIN_POLICY);
    expect(response.body.rankedCandidates.some((row: { selected: boolean }) => row.selected)).toBe(true);
    expect(response.body.rankedCandidates.find((row: { selected: boolean }) => row.selected).productId).toBe(
      DEMO_SHOE_PRODUCT_ID,
    );

    const stored = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: response.body.id },
      include: {
        agentRun: { include: { decisions: true } },
        policyEvaluations: true,
        order: true,
      },
    });
    expect(stored.status).toBe("POLICY_ALLOWED");
    expect(stored.agentRun).not.toBeNull();
    expect(stored.agentRun?.decisions.length).toBeGreaterThan(0);
    expect(stored.agentRun?.decisions.filter((row) => row.selected)).toHaveLength(1);
    expect(stored.agentRun?.decisions.find((row) => row.selected)?.productId).toBe(DEMO_SHOE_PRODUCT_ID);
    expect(stored.policyEvaluations).toHaveLength(1);
    expect(stored.policyEvaluations[0]?.decision).toBe("ALLOW");
    expect(stored.order).toBeNull();

    const fetched = await request(app)
      .get(`/purchase-intents/${response.body.id}`)
      .set(authHeader(customer.token));
    expect(fetched.status).toBe(200);
    expect(fetched.body.status).toBe("POLICY_ALLOWED");
    expect(fetched.body.orderCount).toBe(0);
    expect(fetched.body.policyEvaluations[0].reasonCode).toBe(REASON.WITHIN_POLICY);
  });

  it("reproduces the PRD laptop demo: APPROVAL_PENDING with DAILY_LIMIT_EXCEEDED", async () => {
    installIntentFixtures();
    const customer = await registerCustomer();
    await putPolicy(customer.token);

    const response = await request(app)
      .post("/purchase-intents")
      .set(authHeader(customer.token))
      .send({ text: DEMO_LAPTOP_PHRASE, purchaseMode: "manual" });

    expect(response.status).toBe(201);
    expect(response.body.result).toBe(PIPELINE_RESULT.APPROVAL_PENDING);
    expect(response.body.status).toBe("APPROVAL_PENDING");
    expect(response.body.selectedProduct.id).toBe(DEMO_LAPTOP_PRODUCT_ID);
    expect(response.body.selectedProduct.price).toBe(DEMO_LAPTOP_PRICE);
    expect(response.body.policyDecision.decision).toBe("REQUIRE_APPROVAL");
    expect(response.body.policyDecision.reasonCode).toBe(REASON.DAILY_LIMIT_EXCEEDED);

    const stored = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: response.body.id },
      include: { policyEvaluations: true, order: true, agentRun: { include: { decisions: true } } },
    });
    expect(stored.policyEvaluations[0]?.reasonCode).toBe(REASON.DAILY_LIMIT_EXCEEDED);
    expect(stored.order).toBeNull();
    expect(stored.agentRun?.decisions.some((row) => row.selected && row.productId === DEMO_LAPTOP_PRODUCT_ID)).toBe(
      true,
    );
  });

  it("evaluates a blocked-category request as DENY after ranking, with zero Order rows", async () => {
    installIntentFixtures();
    const customer = await registerCustomer();
    await putPolicy(customer.token, { ...DEMO_POLICY, blockedCategories: ["Sports"] });

    const beforeOrders = await prisma.order.count({
      where: { purchaseIntent: { userId: customer.user.id } },
    });

    const response = await request(app)
      .post("/purchase-intents")
      .set(authHeader(customer.token))
      .send({ text: DEMO_INTENT_PHRASE, purchaseMode: "autonomous" });

    expect(response.status).toBe(201);
    expect(response.body.result).toBe(PIPELINE_RESULT.POLICY_DENIED);
    expect(response.body.status).toBe("POLICY_DENIED");
    expect(response.body.rankedCandidates.length).toBeGreaterThan(0);
    expect(response.body.selectedProduct.id).toBe(DEMO_SHOE_PRODUCT_ID);
    expect(response.body.policyDecision.decision).toBe("DENY");
    expect(response.body.policyDecision.reasonCode).toBe(REASON.CATEGORY_BLOCKED);

    const afterOrders = await prisma.order.count({
      where: { purchaseIntent: { userId: customer.user.id } },
    });
    expect(afterOrders).toBe(beforeOrders);
    expect(afterOrders).toBe(0);

    const stored = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: response.body.id },
      include: { order: true, policyEvaluations: true },
    });
    expect(stored.order).toBeNull();
    expect(stored.policyEvaluations[0]?.decision).toBe("DENY");
  });

  it("stops with NO_MATCHING_PRODUCTS and never calls the policy engine", async () => {
    installIntentFixtures();
    const customer = await registerCustomer();
    await putPolicy(customer.token);

    const response = await request(app)
      .post("/purchase-intents")
      .set(authHeader(customer.token))
      .send({ text: "buy glow moss under ₹2000", purchaseMode: "manual" });

    expect(response.status).toBe(201);
    expect(response.body.result).toBe(PIPELINE_RESULT.NO_MATCHING_PRODUCTS);
    expect(response.body.rankedCandidates).toEqual([]);
    expect(response.body.policyDecision).toBeNull();
    expect(response.body.selectedProduct).toBeNull();

    const stored = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: response.body.id },
      include: { policyEvaluations: true, agentRun: { include: { decisions: true } } },
    });
    expect(stored.status).toBe("INTENT_EXTRACTED");
    expect(stored.policyEvaluations).toHaveLength(0);
    expect(stored.agentRun?.decisions).toHaveLength(0);
  });

  it("sends the catalog price (₹4,499) to policy, not the LLM budget (₹5,000)", async () => {
    installIntentFixtures();
    const customer = await registerCustomer();
    await putPolicy(customer.token, { ...DEMO_POLICY, approvalThreshold: 4900 });

    const response = await request(app)
      .post("/purchase-intents")
      .set(authHeader(customer.token))
      .send({ text: DEMO_INTENT_PHRASE, purchaseMode: "autonomous" });

    expect(response.status).toBe(201);
    expect(response.body.selectedProduct.price).toBe(DEMO_SHOE_PRICE);
    expect(response.body.intent.budget).toBe(5000);
    // 4499 <= 4900 → ALLOW. Passing the LLM budget 5000 would have been REQUIRE_APPROVAL.
    expect(response.body.policyDecision.decision).toBe("ALLOW");
    expect(response.body.policyDecision.reasonCode).toBe(REASON.WITHIN_POLICY);
  });

  it("returns 404 for another customer's purchase intent", async () => {
    installIntentFixtures();
    const owner = await registerCustomer();
    const stranger = await registerCustomer();
    await putPolicy(owner.token);

    const created = await request(app)
      .post("/purchase-intents")
      .set(authHeader(owner.token))
      .send({ text: DEMO_INTENT_PHRASE, purchaseMode: "autonomous" });
    expect(created.status).toBe(201);

    const peek = await request(app)
      .get(`/purchase-intents/${created.body.id}`)
      .set(authHeader(stranger.token));
    expect(peek.status).toBe(404);
    expect(peek.body.error).toBe("NOT_FOUND");
  });
});
