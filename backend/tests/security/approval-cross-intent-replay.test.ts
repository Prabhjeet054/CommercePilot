import { randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { setLLMProviderForTests } from "../../src/lib/get-llm-provider";
import { MockLLMProvider } from "../../src/lib/providers/mock-provider";
import { prisma } from "../../src/lib/prisma";
import { DEMO_LAPTOP_PRODUCT_ID } from "../../src/modules/catalog/catalog.constants";
import { buildIntentPrompt } from "../../src/modules/intent/intent-agent";
import type { LlmIntent } from "../../src/modules/intent/intent.schema";
import { DEMO_LAPTOP_PHRASE } from "../../src/modules/orchestrator/purchase-intent";
import { seedCatalog } from "../../prisma/seed";

/**
 * PRD §23 — Approval replay across purchase intents:
 * A consumed (or pending) approval is bound to Approval.purchaseIntentId and
 * cannot authorize a different intent.
 */

const JWT_SECRET = "security-approval-replay-access!";
const JWT_REFRESH_SECRET = "security-approval-replay-refresh";
process.env.PURCHASE_INTENT_RATE_LIMIT_MAX = "100";
process.env.APPROVAL_DECISION_RATE_LIMIT_MAX = "100";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

const laptopLlm: LlmIntent = {
  category: "laptop",
  budget: 120000,
  currency: "INR",
  purpose: "laptop",
  usage: null,
  priority: null,
  purchaseMode: "manual",
  hasAdditionalUnparsedRequest: false,
};

function clientIp() {
  return `198.51.100.${1 + Math.floor(Math.random() * 200)}`;
}

async function registerCustomer() {
  const email = `sec-replay-${randomUUID()}@example.com`;
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Replay User", role: "customer" });
  expect(response.status).toBe(201);
  return { token: response.body.accessToken as string, email };
}

async function savePolicy(token: string) {
  const response = await request(app)
    .post("/policies")
    .set("Authorization", `Bearer ${token}`)
    .send({
      maxAutonomousAmount: 5000,
      dailySpendingLimit: 10000,
      approvalThreshold: 5000,
      allowedCategories: ["Electronics", "Sports", "Travel"],
      blockedCategories: [],
      trustedMerchants: [],
      autonomousEnabled: true,
      maxAutonomousTxnsPerDay: 20,
    });
  expect([200, 201]).toContain(response.status);
}

describe("security: approval cross-intent replay", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  afterEach(async () => {
    setLLMProviderForTests(null);
    await prisma.approval.deleteMany({
      where: { user: { email: { startsWith: "sec-replay-" } } },
    });
    await prisma.policyEvaluation.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "sec-replay-" } } } },
    });
    await prisma.agentDecision.deleteMany({
      where: { agentRun: { purchaseIntent: { user: { email: { startsWith: "sec-replay-" } } } } },
    });
    await prisma.agentRun.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "sec-replay-" } } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "sec-replay-" } } },
    });
    await prisma.financialPolicy.deleteMany({
      where: { user: { email: { startsWith: "sec-replay-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "sec-replay-" } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("consumed approval for intent A cannot authorize a newly created intent B", async () => {
    setLLMProviderForTests(
      new MockLLMProvider({
        fixtures: {
          [buildIntentPrompt(DEMO_LAPTOP_PHRASE)]: laptopLlm,
        },
      }),
    );

    const customer = await registerCustomer();
    await savePolicy(customer.token);

    const first = await request(app)
      .post("/purchase-intents")
      .set("Authorization", `Bearer ${customer.token}`)
      .set("X-Forwarded-For", clientIp())
      .send({ text: DEMO_LAPTOP_PHRASE, purchaseMode: "manual" });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("APPROVAL_PENDING");
    const approvalA = first.body.approval.id as string;
    const intentA = first.body.id as string;

    const approveA = await request(app)
      .post(`/approvals/${approvalA}/decision`)
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ decision: "approve" });
    expect(approveA.status).toBe(200);

    const second = await request(app)
      .post("/purchase-intents")
      .set("Authorization", `Bearer ${customer.token}`)
      .set("X-Forwarded-For", clientIp())
      .send({ text: DEMO_LAPTOP_PHRASE, purchaseMode: "manual" });
    expect(second.status).toBe(201);
    expect(second.body.status).toBe("APPROVAL_PENDING");
    const intentB = second.body.id as string;
    const approvalB = second.body.approval.id as string;
    expect(approvalB).not.toBe(approvalA);
    expect(intentB).not.toBe(intentA);

    // Replay consumed approval A — cannot move intent B.
    const replay = await request(app)
      .post(`/approvals/${approvalA}/decision`)
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ decision: "approve" });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("ALREADY_CONSUMED");

    const intentBRow = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intentB } });
    expect(intentBRow.status).toBe("APPROVAL_PENDING");

    const approvalARow = await prisma.approval.findUniqueOrThrow({ where: { id: approvalA } });
    expect(approvalARow.purchaseIntentId).toBe(intentA);
    expect(approvalARow.status).toBe("APPROVED");
  });
});
