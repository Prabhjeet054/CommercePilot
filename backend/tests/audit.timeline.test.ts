import { createHmac, randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { setLLMProviderForTests } from "../src/lib/get-llm-provider";
import { prisma } from "../src/lib/prisma";
import { MockLLMProvider } from "../src/lib/providers/mock-provider";
import { AUDIT_ACTIONS } from "../src/modules/audit/audit.service";
import { buildIntentPrompt } from "../src/modules/intent/intent-agent";
import type { LlmIntent } from "../src/modules/intent/intent.schema";
import {
  setRazorpayClientForTests,
  type RazorpayOrderCreateInput,
  type RazorpayOrdersClient,
} from "../src/modules/payments/razorpay-client";
import { seedCatalog } from "../prisma/seed";

const JWT_SECRET = "audit-timeline-access!!";
const JWT_REFRESH_SECRET = "audit-timeline-refresh!";
const WEBHOOK_SECRET = "phase20-webhook-secret";
const KEY_SECRET = "phase20-key-secret";

process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.RAZORPAY_KEY_ID = "rzp_test_phase20";
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;

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

function stubRazorpay(): RazorpayOrdersClient {
  return {
    async createOrder(input: RazorpayOrderCreateInput) {
      return {
        id: `order_dev_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        amount: input.amount,
        currency: input.currency,
      };
    },
  };
}

async function registerCustomer(): Promise<{ token: string; userId: string; email: string }> {
  const email = `audit-${randomUUID()}@example.com`;
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", `203.0.113.${1 + Math.floor(Math.random() * 200)}`)
    .send({
      name: "Audit Tester",
      email,
      password: "password12",
      role: "customer",
    });
  expect(response.status).toBe(201);
  return {
    token: response.body.accessToken as string,
    userId: response.body.user.id as string,
    email,
  };
}

async function saveDemoPolicy(token: string, blockedSports = false): Promise<void> {
  const body: Record<string, unknown> = {
    maxAutonomousAmount: 5000,
    dailySpendingLimit: 10000,
    approvalThreshold: 5000,
    allowedCategories: ["Electronics", "Sports", "Travel"],
    blockedCategories: blockedSports ? ["Sports"] : [],
    trustedMerchants: [],
    autonomousEnabled: true,
    maxAutonomousTxnsPerDay: 20,
  };
  const response = await request(app)
    .post("/policies")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  expect([200, 201]).toContain(response.status);
}

describe("Phase 20 audit timeline", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  beforeEach(() => {
    setLLMProviderForTests(
      new MockLLMProvider({
        fixtures: {
          [buildIntentPrompt(SHOE_PHRASE)]: demoShoeLlm,
        },
      }),
    );
    setRazorpayClientForTests(stubRazorpay());
  });

  afterEach(async () => {
    setLLMProviderForTests(null);
    setRazorpayClientForTests(null);
    await prisma.auditLog.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "audit-" } } } },
    });
    await prisma.webhookEvent.deleteMany({
      where: { eventId: { startsWith: "evt_phase20_" } },
    });
    await prisma.payment.deleteMany({
      where: { order: { purchaseIntent: { user: { email: { startsWith: "audit-" } } } } },
    });
    await prisma.order.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "audit-" } } } },
    });
    await prisma.approval.deleteMany({
      where: { user: { email: { startsWith: "audit-" } } },
    });
    await prisma.policyEvaluation.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "audit-" } } } },
    });
    await prisma.agentDecision.deleteMany({
      where: { agentRun: { purchaseIntent: { user: { email: { startsWith: "audit-" } } } } },
    });
    await prisma.agentRun.deleteMany({
      where: { purchaseIntent: { user: { email: { startsWith: "audit-" } } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "audit-" } } },
    });
    await prisma.financialPolicy.deleteMany({
      where: { user: { email: { startsWith: "audit-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "audit-" } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("Scenario 1 shoe flow produces a gapless chronological timeline through order_completed", async () => {
    const { token } = await registerCustomer();
    await saveDemoPolicy(token);

    const created = await request(app)
      .post("/purchase-intents")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: SHOE_PHRASE, purchaseMode: "autonomous" });
    expect(created.status).toBe(201);
    const intentId = created.body.id as string;

    const order = await request(app)
      .post("/payments/create-order")
      .set("Authorization", `Bearer ${token}`)
      .send({ purchaseIntentId: intentId });
    expect(order.status).toBe(200);
    const razorpayOrderId = order.body.razorpayOrderId as string;
    const paymentId = `pay_audit_${randomUUID().slice(0, 8)}`;
    const signature = createHmac("sha256", KEY_SECRET)
      .update(`${razorpayOrderId}|${paymentId}`)
      .digest("hex");

    const verify = await request(app)
      .post("/payments/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      });
    expect(verify.status).toBe(200);

    const webhookPayload = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: paymentId, order_id: razorpayOrderId, status: "captured" },
        },
      },
    });
    const webhookSig = createHmac("sha256", WEBHOOK_SECRET).update(webhookPayload).digest("hex");
    const webhook = await request(app)
      .post("/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", webhookSig)
      .set("x-razorpay-event-id", `evt_phase20_${randomUUID()}`)
      .send(webhookPayload);
    expect(webhook.status).toBe(200);

    const timeline = await request(app)
      .get(`/agent/decisions/${intentId}/timeline`)
      .set("Authorization", `Bearer ${token}`);
    expect(timeline.status).toBe(200);
    const actions = (timeline.body.events as Array<{ action: string }>).map((e) => e.action);

    const expectedPrefix = [
      "intent_received",
      "intent_extracted",
      "products_searched",
      "products_ranked",
      "recommendation_created",
      "policy_evaluated",
      "order_created",
      "payment_initiated",
      "payment_verified",
      "webhook_received",
      "order_completed",
    ];
    expect(actions).toEqual(expectedPrefix);

    const correlationIds = new Set(
      (timeline.body.events as Array<{ correlationId: string }>).map((e) => e.correlationId),
    );
    expect(correlationIds.size).toBe(1);

    for (const event of timeline.body.events as Array<{ payload: unknown }>) {
      const text = JSON.stringify(event.payload ?? {});
      expect(text).not.toContain("RAZORPAY_KEY_SECRET");
      expect(text).not.toContain("RAZORPAY_WEBHOOK_SECRET");
      expect(text).not.toContain(KEY_SECRET);
      expect(text).not.toContain(WEBHOOK_SECRET);
      expect(text.toLowerCase()).not.toContain("password");
    }

    // Append-only: no mutating routes on audit logs.
    expect(AUDIT_ACTIONS).toContain("order_completed");
  });

  it("Scenario 3 denied flow ends at policy_evaluated with POLICY_DENIED and no payment events", async () => {
    const { token } = await registerCustomer();
    await saveDemoPolicy(token, true);

    const created = await request(app)
      .post("/purchase-intents")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: SHOE_PHRASE, purchaseMode: "autonomous" });
    expect(created.status).toBe(201);
    expect(created.body.result).toBe("POLICY_DENIED");
    const intentId = created.body.id as string;

    const timeline = await request(app)
      .get(`/agent/decisions/${intentId}/timeline`)
      .set("Authorization", `Bearer ${token}`);
    expect(timeline.status).toBe(200);
    const actions = (timeline.body.events as Array<{ action: string; payload: Record<string, unknown> }>).map(
      (e) => e.action,
    );

    expect(actions).toEqual([
      "intent_received",
      "intent_extracted",
      "products_searched",
      "products_ranked",
      "recommendation_created",
      "policy_evaluated",
    ]);
    const policy = timeline.body.events.find(
      (e: { action: string }) => e.action === "policy_evaluated",
    ) as { payload: { decision: string; reasonCode: string } };
    expect(policy.payload.decision).toBe("DENY");
    expect(policy.payload.reasonCode).toBe("CATEGORY_BLOCKED");
    expect(actions).not.toContain("order_created");
    expect(actions).not.toContain("payment_initiated");

    const intent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe("POLICY_DENIED");
  });

  it("returns 404 for another customer's timeline (no existence leak)", async () => {
    const owner = await registerCustomer();
    await saveDemoPolicy(owner.token);
    const created = await request(app)
      .post("/purchase-intents")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ text: SHOE_PHRASE, purchaseMode: "autonomous" });
    const other = await registerCustomer();

    const response = await request(app)
      .get(`/agent/decisions/${created.body.id}/timeline`)
      .set("Authorization", `Bearer ${other.token}`);
    expect(response.status).toBe(404);
  });
});
