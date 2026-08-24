import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { REASON } from "../src/modules/policy/evaluate";
import { evaluateAndPersist } from "../src/modules/policy/policy.service";

function uniqueEmail(): string {
  return `policy-test-${randomUUID()}@example.com`;
}

const NOW = new Date("2026-08-24T12:00:00.000Z");

async function fixture(opts?: { withPolicy?: boolean; autonomousEnabled?: boolean }) {
  const user = await prisma.user.create({
    data: {
      email: uniqueEmail(),
      passwordHash: "hashed-password-not-plaintext",
      role: "customer",
      name: "Policy Test User",
    },
  });
  const merchant = await prisma.merchant.create({
    data: { name: `policy-test-m-${randomUUID()}` },
  });
  const product = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      name: `policy-test-p-${randomUUID()}`,
      category: "Sports",
      price: "4499.00",
    },
  });
  const intent = await prisma.purchaseIntent.create({
    data: {
      userId: user.id,
      rawText: "policy-test-intent",
      structuredIntent: { category: "Sports" },
      purchaseMode: "autonomous",
      status: "CREATED",
    },
  });

  if (opts?.withPolicy !== false) {
    await prisma.financialPolicy.create({
      data: {
        userId: user.id,
        maxAutonomousAmount: "5000.00",
        dailySpendingLimit: "10000.00",
        approvalThreshold: "5000.00",
        allowedCategories: ["Electronics", "Sports", "Travel"],
        blockedCategories: [],
        trustedMerchants: [],
        autonomousEnabled: opts?.autonomousEnabled ?? true,
        maxAutonomousTxnsPerDay: 3,
      },
    });
  }

  return { user, merchant, product, intent };
}

describe("evaluateAndPersist", () => {
  afterAll(async () => {
    await prisma.policyEvaluation.deleteMany({
      where: { purchaseIntent: { rawText: "policy-test-intent" } },
    });
    await prisma.order.deleteMany({
      where: { purchaseIntent: { rawText: "policy-test-intent" } },
    });
    await prisma.purchaseIntent.deleteMany({ where: { rawText: "policy-test-intent" } });
    await prisma.product.deleteMany({ where: { name: { startsWith: "policy-test-p-" } } });
    await prisma.financialPolicy.deleteMany({
      where: { user: { email: { startsWith: "policy-test-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "policy-test-" } } });
    await prisma.merchant.deleteMany({ where: { name: { startsWith: "policy-test-m-" } } });
    await prisma.$disconnect();
  });

  it("persists ALLOW / WITHIN_POLICY with a full policy snapshot for the ₹4,499 shoe", async () => {
    const { user, merchant, intent } = await fixture();
    const result = await evaluateAndPersist({
      userId: user.id,
      purchaseIntentId: intent.id,
      proposal: { amount: 4499, category: "Sports", merchantId: merchant.id },
      now: NOW,
    });

    expect(result.decision).toBe("ALLOW");
    expect(result.reasonCode).toBe(REASON.WITHIN_POLICY);
    expect(result.evaluation.decision).toBe("ALLOW");
    expect(result.evaluation.reasonCode).toBe(REASON.WITHIN_POLICY);
    expect(result.policySnapshot).toMatchObject({
      configured: true,
      userId: user.id,
      maxAutonomousAmount: "5000.00",
      dailySpendingLimit: "10000.00",
      approvalThreshold: "5000.00",
      allowedCategories: ["Electronics", "Sports", "Travel"],
      blockedCategories: [],
      autonomousEnabled: true,
      maxAutonomousTxnsPerDay: 3,
    });

    const stored = await prisma.policyEvaluation.findUniqueOrThrow({
      where: { id: result.evaluation.id },
    });
    const snapshot = stored.policySnapshot as Record<string, unknown>;
    expect(snapshot.configured).toBe(true);
    expect(snapshot.maxAutonomousAmount).toBe("5000.00");
    expect(snapshot.allowedCategories).toEqual(["Electronics", "Sports", "Travel"]);
  });

  it("persists REQUIRE_APPROVAL for the ₹1,20,000 laptop (daily limit binds first on the demo policy)", async () => {
    const { user, merchant, intent } = await fixture();
    const result = await evaluateAndPersist({
      userId: user.id,
      purchaseIntentId: intent.id,
      proposal: { amount: 120_000, category: "Electronics", merchantId: merchant.id },
      now: NOW,
    });
    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.reasonCode).toBe(REASON.DAILY_LIMIT_EXCEEDED);
    expect(result.decision).not.toBe("ALLOW");
  });

  it("does not throw when the user has no policy; persists REQUIRE_APPROVAL / NO_POLICY_CONFIGURED", async () => {
    const { user, merchant, intent } = await fixture({ withPolicy: false });
    const result = await evaluateAndPersist({
      userId: user.id,
      purchaseIntentId: intent.id,
      proposal: { amount: 100, category: "Sports", merchantId: merchant.id },
      now: NOW,
    });
    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.reasonCode).toBe(REASON.NO_POLICY_CONFIGURED);
    expect(result.decision).not.toBe("ALLOW");
    expect(result.policySnapshot.configured).toBe(false);

    const stored = await prisma.policyEvaluation.findUniqueOrThrow({
      where: { id: result.evaluation.id },
    });
    expect(stored.reasonCode).toBe(REASON.NO_POLICY_CONFIGURED);
    expect((stored.policySnapshot as { configured: boolean }).configured).toBe(false);
  });

  it("counts today's COMPLETED order amounts and autonomous-mode completions", async () => {
    const { user, merchant, product, intent } = await fixture();

    const autonomousIntent = await prisma.purchaseIntent.create({
      data: {
        userId: user.id,
        rawText: "policy-test-intent",
        structuredIntent: {},
        purchaseMode: "autonomous",
        status: "COMPLETED",
      },
    });
    const manualIntent = await prisma.purchaseIntent.create({
      data: {
        userId: user.id,
        rawText: "policy-test-intent",
        structuredIntent: {},
        purchaseMode: "manual",
        status: "COMPLETED",
      },
    });
    const yesterdayIntent = await prisma.purchaseIntent.create({
      data: {
        userId: user.id,
        rawText: "policy-test-intent",
        structuredIntent: {},
        purchaseMode: "autonomous",
        status: "COMPLETED",
      },
    });

    await prisma.order.create({
      data: {
        purchaseIntentId: autonomousIntent.id,
        productId: product.id,
        amount: new Prisma.Decimal("2000.00"),
        state: "COMPLETED",
        createdAt: NOW,
      },
    });
    await prisma.order.create({
      data: {
        purchaseIntentId: manualIntent.id,
        productId: product.id,
        amount: new Prisma.Decimal("1500.00"),
        state: "COMPLETED",
        createdAt: NOW,
      },
    });
    await prisma.order.create({
      data: {
        purchaseIntentId: yesterdayIntent.id,
        productId: product.id,
        amount: new Prisma.Decimal("9000.00"),
        state: "COMPLETED",
        createdAt: new Date("2026-08-23T12:00:00.000Z"),
      },
    });

    const result = await evaluateAndPersist({
      userId: user.id,
      purchaseIntentId: intent.id,
      proposal: { amount: 4499, category: "Sports", merchantId: merchant.id },
      now: NOW,
    });

    expect(result.todaySpend).toBe(3500);
    expect(result.todayAutonomousCount).toBe(1);
    expect(result.decision).toBe("ALLOW");
  });
});
