import { randomUUID } from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { setLLMProviderForTests } from "../src/lib/get-llm-provider";
import { prisma } from "../src/lib/prisma";
import { MockLLMProvider } from "../src/lib/providers/mock-provider";
import { DEMO_LAPTOP_PRICE, DEMO_LAPTOP_PRODUCT_ID } from "../src/modules/catalog/catalog.constants";
import { buildIntentPrompt } from "../src/modules/intent/intent-agent";
import type { LlmIntent } from "../src/modules/intent/intent.schema";
import { decideApproval } from "../src/modules/approvals/approval.service";
import { DEMO_LAPTOP_PHRASE } from "../src/modules/orchestrator/purchase-intent";
import { REASON } from "../src/modules/policy/evaluate";
import { seedCatalog } from "../prisma/seed";

const JWT_SECRET = "approval-api-access-secret";
const JWT_REFRESH_SECRET = "approval-api-refresh-secret";

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

function uniqueEmail(prefix = "approval-test"): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

function clientIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function installLaptopFixture(): void {
  setLLMProviderForTests(
    new MockLLMProvider({
      fixtures: {
        [buildIntentPrompt(DEMO_LAPTOP_PHRASE)]: demoLaptopLlm,
      },
    }),
  );
}

async function registerCustomer(prefix = "approval-test") {
  const email = uniqueEmail(prefix);
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Approval User", role: "customer" });
  expect(response.status).toBe(201);
  return {
    email,
    token: response.body.accessToken as string,
    user: response.body.user as { id: string; role: string },
  };
}

async function putPolicy(token: string, policy: Record<string, unknown> = DEMO_POLICY) {
  const response = await request(app).post("/policies").set(authHeader(token)).send(policy);
  expect([200, 201]).toContain(response.status);
  return response.body;
}

async function createLaptopApproval(token: string) {
  const response = await request(app)
    .post("/purchase-intents")
    .set(authHeader(token))
    .send({ text: DEMO_LAPTOP_PHRASE, purchaseMode: "manual" });
  expect(response.status).toBe(201);
  expect(response.body.approval?.id).toBeTruthy();
  return {
    intentId: response.body.id as string,
    approvalId: response.body.approval.id as string,
    approval: response.body.approval as { id: string; status: string },
  };
}

describe("Approval API", () => {
  beforeAll(async () => {
    await seedCatalog();
  });

  afterEach(() => {
    setLLMProviderForTests(null);
  });

  afterAll(async () => {
    await prisma.approval.deleteMany({
      where: { user: { email: { startsWith: "approval-test-" } } },
    });
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "approval-test-" } } },
    });
    await prisma.financialPolicy.deleteMany({
      where: { user: { email: { startsWith: "approval-test-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "approval-test-" } } });
    await prisma.$disconnect();
  });

  it("returns 401 for pending approvals without a bearer token", async () => {
    const response = await request(app).get("/approvals/pending");
    expect(response.status).toBe(401);
  });

  it("the ₹1,20,000 laptop demo creates a real PENDING Approval row", async () => {
    installLaptopFixture();
    const customer = await registerCustomer();
    await putPolicy(customer.token);
    const created = await createLaptopApproval(customer.token);

    const row = await prisma.approval.findUniqueOrThrow({ where: { id: created.approvalId } });
    expect(row.status).toBe("PENDING");
    expect(row.userId).toBe(customer.user.id);
    expect(row.purchaseIntentId).toBe(created.intentId);
    expect(row.productId).toBe(DEMO_LAPTOP_PRODUCT_ID);
    expect(row.amount?.toFixed(2)).toBe(DEMO_LAPTOP_PRICE);
    expect(row.reasonCode).toBe(REASON.DAILY_LIMIT_EXCEEDED);
    expect(row.expiresAt).not.toBeNull();
    expect(row.consumedAt).toBeNull();
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);

    const pending = await request(app).get("/approvals/pending").set(authHeader(customer.token));
    expect(pending.status).toBe(200);
    expect(pending.body.approvals.some((item: { id: string }) => item.id === created.approvalId)).toBe(true);

    const detail = await request(app)
      .get(`/approvals/${created.approvalId}`)
      .set(authHeader(customer.token));
    expect(detail.status).toBe(200);
    expect(detail.body.productName).toMatch(/Nova Ultrabook/);
    expect(detail.body.merchantName).toBe("Nova Electronics");
    expect(detail.body.amount).toBe(DEMO_LAPTOP_PRICE);
    expect(detail.body.reasonCode).toBe(REASON.DAILY_LIMIT_EXCEEDED);
    expect(detail.body.rationale.length).toBeGreaterThan(0);
  });

  it("returns 404 (not 403) when another user tries to decide someone else's approval", async () => {
    installLaptopFixture();
    const owner = await registerCustomer();
    const stranger = await registerCustomer();
    await putPolicy(owner.token);
    const created = await createLaptopApproval(owner.token);

    const peek = await request(app)
      .get(`/approvals/${created.approvalId}`)
      .set(authHeader(stranger.token));
    expect(peek.status).toBe(404);
    expect(peek.body.error).toBe("NOT_FOUND");

    const decide = await request(app)
      .post(`/approvals/${created.approvalId}/decision`)
      .set(authHeader(stranger.token))
      .send({ decision: "approve" });
    expect(decide.status).toBe(404);
    expect(decide.body.error).toBe("NOT_FOUND");

    const stillPending = await prisma.approval.findUniqueOrThrow({ where: { id: created.approvalId } });
    expect(stillPending.status).toBe("PENDING");
    expect(stillPending.consumedAt).toBeNull();
  });

  it("approving a pending approval consumes it and advances the intent to APPROVED", async () => {
    installLaptopFixture();
    const customer = await registerCustomer();
    await putPolicy(customer.token);
    const created = await createLaptopApproval(customer.token);

    const first = await request(app)
      .post(`/approvals/${created.approvalId}/decision`)
      .set(authHeader(customer.token))
      .send({ decision: "approve" });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("APPROVED");
    expect(first.body.consumedAt).toBeTruthy();

    const row = await prisma.approval.findUniqueOrThrow({ where: { id: created.approvalId } });
    expect(row.status).toBe("APPROVED");
    expect(row.consumedAt).not.toBeNull();

    const intent = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: created.intentId },
      include: { order: true, agentRun: true },
    });
    expect(intent.status).toBe("APPROVED");
    expect(intent.order).toBeNull();
    expect(await prisma.order.count({ where: { purchaseIntentId: created.intentId } })).toBe(0);

    const stored = await request(app)
      .get(`/purchase-intents/${created.intentId}`)
      .set(authHeader(customer.token));
    expect(stored.status).toBe(200);
    expect(stored.body.status).toBe("APPROVED");
    expect(stored.body.approval.status).toBe("APPROVED");
    expect(stored.body.orderCount).toBe(0);
  });

  it("returns 409 ALREADY_CONSUMED on replay and does not re-trigger downstream effects", async () => {
    installLaptopFixture();
    const customer = await registerCustomer();
    await putPolicy(customer.token);
    const created = await createLaptopApproval(customer.token);

    const first = await request(app)
      .post(`/approvals/${created.approvalId}/decision`)
      .set(authHeader(customer.token))
      .send({ decision: "approve" });
    expect(first.status).toBe(200);

    const afterFirst = await prisma.approval.findUniqueOrThrow({ where: { id: created.approvalId } });
    const intentAfterFirst = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: created.intentId },
    });
    expect(afterFirst.consumedAt).not.toBeNull();
    const consumedAt = afterFirst.consumedAt!.toISOString();

    const replay = await request(app)
      .post(`/approvals/${created.approvalId}/decision`)
      .set(authHeader(customer.token))
      .send({ decision: "approve" });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("ALREADY_CONSUMED");

    const rejectReplay = await request(app)
      .post(`/approvals/${created.approvalId}/decision`)
      .set(authHeader(customer.token))
      .send({ decision: "reject" });
    expect(rejectReplay.status).toBe(409);
    expect(rejectReplay.body.error).toBe("ALREADY_CONSUMED");

    const afterReplay = await prisma.approval.findUniqueOrThrow({ where: { id: created.approvalId } });
    expect(afterReplay.status).toBe("APPROVED");
    expect(afterReplay.consumedAt?.toISOString()).toBe(consumedAt);

    const intentAfterReplay = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: created.intentId },
    });
    expect(intentAfterReplay.status).toBe("APPROVED");
    expect(intentAfterReplay.status).toBe(intentAfterFirst.status);
    expect(await prisma.order.count({ where: { purchaseIntentId: created.intentId } })).toBe(0);
    expect(await prisma.approval.count({ where: { purchaseIntentId: created.intentId } })).toBe(1);
  });

  it("rejecting a pending approval marks it REJECTED and halts the pipeline with no Order", async () => {
    installLaptopFixture();
    const customer = await registerCustomer();
    await putPolicy(customer.token);
    const created = await createLaptopApproval(customer.token);

    const first = await request(app)
      .post(`/approvals/${created.approvalId}/decision`)
      .set(authHeader(customer.token))
      .send({ decision: "reject" });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("REJECTED");

    const row = await prisma.approval.findUniqueOrThrow({ where: { id: created.approvalId } });
    expect(row.status).toBe("REJECTED");
    expect(row.consumedAt).not.toBeNull();

    const intent = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: created.intentId },
      include: { order: true },
    });
    expect(intent.status).toBe("APPROVAL_REJECTED");
    expect(intent.order).toBeNull();
    expect(await prisma.order.count({ where: { purchaseIntentId: created.intentId } })).toBe(0);

    const replay = await request(app)
      .post(`/approvals/${created.approvalId}/decision`)
      .set(authHeader(customer.token))
      .send({ decision: "approve" });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("ALREADY_CONSUMED");

    const afterReplay = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: created.intentId } });
    expect(afterReplay.status).toBe("APPROVAL_REJECTED");
    const approvalAfterReplay = await prisma.approval.findUniqueOrThrow({ where: { id: created.approvalId } });
    expect(approvalAfterReplay.status).toBe("REJECTED");
  });

  it("returns 409 EXPIRED for an expired pending approval", async () => {
    installLaptopFixture();
    const customer = await registerCustomer();
    await putPolicy(customer.token);
    const created = await createLaptopApproval(customer.token);

    await prisma.approval.update({
      where: { id: created.approvalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const expired = await request(app)
      .post(`/approvals/${created.approvalId}/decision`)
      .set(authHeader(customer.token))
      .send({ decision: "approve" });
    expect(expired.status).toBe(409);
    expect(expired.body.error).toBe("EXPIRED");

    const row = await prisma.approval.findUniqueOrThrow({ where: { id: created.approvalId } });
    expect(row.status).toBe("EXPIRED");
    expect(row.consumedAt).toBeNull();

    const intent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: created.intentId } });
    expect(intent.status).toBe("EXPIRED");
    expect(await prisma.order.count({ where: { purchaseIntentId: created.intentId } })).toBe(0);
  });

  it("two simultaneous approve requests result in exactly one success and one 409", async () => {
    installLaptopFixture();
    const customer = await registerCustomer();
    await putPolicy(customer.token);
    const created = await createLaptopApproval(customer.token);

    const [first, second] = await Promise.all([
      request(app)
        .post(`/approvals/${created.approvalId}/decision`)
        .set(authHeader(customer.token))
        .send({ decision: "approve" }),
      request(app)
        .post(`/approvals/${created.approvalId}/decision`)
        .set(authHeader(customer.token))
        .send({ decision: "approve" }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = first.status === 200 ? first : second;
    const loser = first.status === 409 ? first : second;
    expect(winner.body.status).toBe("APPROVED");
    expect(loser.body.error).toBe("ALREADY_CONSUMED");

    const rows = await prisma.approval.findMany({ where: { id: created.approvalId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("APPROVED");
    expect(rows[0]?.consumedAt).not.toBeNull();

    const intent = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: created.intentId },
      include: { order: true, agentRun: true },
    });
    expect(intent.status).toBe("APPROVED");
    expect(intent.order).toBeNull();
    expect(intent.agentRun).not.toBeNull();
    expect(await prisma.order.count({ where: { purchaseIntentId: created.intentId } })).toBe(0);
    expect(await prisma.agentRun.count({ where: { purchaseIntentId: created.intentId } })).toBe(1);
  });

  it("conflicting simultaneous decideApproval calls: exactly one wins across 5 iterations", async () => {
    installLaptopFixture();
    const customer = await registerCustomer();
    await putPolicy(customer.token);

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const created = await createLaptopApproval(customer.token);
      const beforeRuns = await prisma.agentRun.count({ where: { purchaseIntentId: created.intentId } });

      const [approve, reject] = await Promise.all([
        request(app)
          .post(`/approvals/${created.approvalId}/decision`)
          .set(authHeader(customer.token))
          .send({ decision: "approve" }),
        request(app)
          .post(`/approvals/${created.approvalId}/decision`)
          .set(authHeader(customer.token))
          .send({ decision: "reject" }),
      ]);

      const statuses = [approve.status, reject.status].sort();
      expect(statuses, `iteration ${iteration}`).toEqual([200, 409]);

      const winner = approve.status === 200 ? approve : reject;
      const loser = approve.status === 409 ? approve : reject;
      expect(loser.body.error).toBe("ALREADY_CONSUMED");
      expect(["APPROVED", "REJECTED"]).toContain(winner.body.status);

      const rows = await prisma.approval.findMany({ where: { id: created.approvalId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.consumedAt).not.toBeNull();
      expect(rows[0]?.status).toBe(winner.body.status);

      const intent = await prisma.purchaseIntent.findUniqueOrThrow({
        where: { id: created.intentId },
        include: { order: true, agentRun: true, approval: true },
      });
      const expectedIntent = winner.body.status === "APPROVED" ? "APPROVED" : "APPROVAL_REJECTED";
      expect(intent.status).toBe(expectedIntent);
      expect(intent.order).toBeNull();
      expect(intent.approval?.id).toBe(created.approvalId);
      expect(await prisma.order.count({ where: { purchaseIntentId: created.intentId } })).toBe(0);
      expect(await prisma.approval.count({ where: { purchaseIntentId: created.intentId } })).toBe(1);
      expect(await prisma.agentRun.count({ where: { purchaseIntentId: created.intentId } })).toBe(beforeRuns);
    }
  });

  it("direct decideApproval races with conflicting decisions: exactly one ok across 5 iterations", async () => {
    installLaptopFixture();
    const customer = await registerCustomer();
    await putPolicy(customer.token);

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const created = await createLaptopApproval(customer.token);

      const [approve, reject] = await Promise.all([
        decideApproval(created.approvalId, customer.user.id, "approve"),
        decideApproval(created.approvalId, customer.user.id, "reject"),
      ]);

      const wins = [approve, reject].filter((row) => row.ok);
      const losses = [approve, reject].filter((row) => !row.ok);
      expect(wins, `iteration ${iteration}`).toHaveLength(1);
      expect(losses).toHaveLength(1);
      expect(losses[0]).toEqual({ ok: false, reason: "ALREADY_CONSUMED" });

      const row = await prisma.approval.findUniqueOrThrow({ where: { id: created.approvalId } });
      expect(row.consumedAt).not.toBeNull();
      const expectedApproval = approve.ok ? "APPROVED" : "REJECTED";
      expect(row.status).toBe(expectedApproval);

      const intent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: created.intentId } });
      expect(intent.status).toBe(approve.ok ? "APPROVED" : "APPROVAL_REJECTED");
      expect(await prisma.order.count({ where: { purchaseIntentId: created.intentId } })).toBe(0);
      expect(await prisma.approval.count({ where: { purchaseIntentId: created.intentId } })).toBe(1);
    }
  });
});
