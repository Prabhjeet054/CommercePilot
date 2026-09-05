import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertDemoSnapshotsEquivalent,
  CANONICAL_DEMO,
  captureDemoSnapshot,
  resetDemo,
} from "../prisma/reset-demo";
import { prisma } from "../src/lib/prisma";
import { DEMO_SHOE_PRODUCT_ID } from "../src/modules/catalog/catalog.constants";
import { seedCatalog } from "../prisma/seed";

/**
 * Phase 25 — meta-test: after a "full demo" of transactional junk, resetDemo()
 * restores a DB state equivalent to a fresh seed (zero transactional rows +
 * canonical catalog/policy key values).
 */

describe("demo:reset meta", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reset after simulated demo matches a fresh seed snapshot", async () => {
    await seedCatalog();
    await resetDemo();
    const fresh = await captureDemoSnapshot();

    expect(fresh.transactional).toEqual(CANONICAL_DEMO.zeroTransactional);
    expect(fresh.demoShoePrice).toBe(CANONICAL_DEMO.shoePrice);
    expect(fresh.demoLaptopPrice).toBe(CANONICAL_DEMO.laptopPrice);
    expect(fresh.priyaPolicy).toEqual({
      maxAutonomousAmount: "5000.00",
      dailySpendingLimit: "10000.00",
      approvalThreshold: "5000.00",
      autonomousEnabled: true,
      maxAutonomousTxnsPerDay: 3,
    });
    expect(fresh.merchants).toBe(CANONICAL_DEMO.merchants);
    expect(fresh.products).toBe(CANONICAL_DEMO.products);
    expect(fresh.users).toBe(CANONICAL_DEMO.users);
    expect(fresh.policies).toBe(CANONICAL_DEMO.policies);

    const priya = await prisma.user.findUniqueOrThrow({
      where: { email: CANONICAL_DEMO.priyaEmail },
    });

    // Simulate leftover demo / QA transactional state (FK-safe chain).
    const intent = await prisma.purchaseIntent.create({
      data: {
        userId: priya.id,
        rawText: "simulated demo shoe purchase",
        structuredIntent: { category: "Sports" },
        purchaseMode: "autonomous",
        status: "COMPLETED",
        agentRun: {
          create: {
            status: "COMPLETED",
            decisions: {
              create: {
                productId: DEMO_SHOE_PRODUCT_ID,
                selected: true,
                rank: 1,
                score: 95,
              },
            },
          },
        },
        policyEvaluations: {
          create: {
            decision: "ALLOW",
            reasonCode: "WITHIN_POLICY",
            policySnapshot: {},
          },
        },
        order: {
          create: {
            productId: DEMO_SHOE_PRODUCT_ID,
            amount: CANONICAL_DEMO.shoePrice,
            currency: "INR",
            state: "COMPLETED",
            razorpayOrderId: `order_demo_${randomUUID().slice(0, 8)}`,
            payments: {
              create: {
                status: "CAPTURED",
                razorpayPaymentId: `pay_demo_${randomUUID().slice(0, 8)}`,
                signatureVerified: true,
              },
            },
          },
        },
        auditLogs: {
          create: {
            actor: "system",
            action: "demo_simulated",
            payload: { note: "phase25 meta" },
          },
        },
      },
    });

    await prisma.notification.create({
      data: {
        userId: priya.id,
        type: "demo",
        message: "simulated",
      },
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { purchaseIntentId: intent.id } });
    await prisma.webhookEvent.create({
      data: {
        eventId: `evt_demo_${randomUUID()}`,
        eventType: "payment.captured",
        orderId: order.id,
        rawPayload: {},
        signatureValid: true,
        processedAt: new Date(),
      },
    });

    const dirty = await captureDemoSnapshot();
    expect(dirty.transactional.purchase_intents).toBeGreaterThan(0);
    expect(dirty.transactional.orders).toBeGreaterThan(0);
    expect(dirty.transactional.payments).toBeGreaterThan(0);

    await resetDemo();
    const afterReset = await captureDemoSnapshot();

    assertDemoSnapshotsEquivalent(fresh, afterReset);
    expect(afterReset.transactional).toEqual(CANONICAL_DEMO.zeroTransactional);
    expect(afterReset.demoShoePrice).toBe(CANONICAL_DEMO.shoePrice);
    expect(afterReset.demoLaptopPrice).toBe(CANONICAL_DEMO.laptopPrice);
  });
});
