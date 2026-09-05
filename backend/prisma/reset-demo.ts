import {
  DEMO_LAPTOP_PRICE,
  DEMO_LAPTOP_PRODUCT_ID,
  DEMO_SHOE_PRICE,
  DEMO_SHOE_PRODUCT_ID,
} from "../src/modules/catalog/catalog.constants";
import { prisma } from "../src/lib/prisma";
import {
  listSeedMerchantIds,
  listSeedProductIds,
  listSeedUserEmails,
  seedCatalog,
  type SeedSummary,
} from "./seed";

/**
 * Phase 25 — truncate transactional demo state and re-apply Phase 4/5 fixtures.
 * Also removes non-seed users/merchants/products left by tests so counts match
 * the canonical demo catalog.
 */

const TRANSACTIONAL_TABLES = [
  "payments",
  "webhook_events",
  "approvals",
  "agent_decisions",
  "agent_runs",
  "policy_evaluations",
  "orders",
  "audit_logs",
  "notifications",
  "purchase_intents",
] as const;

export type DemoSnapshot = {
  transactional: Record<(typeof TRANSACTIONAL_TABLES)[number], number>;
  merchants: number;
  products: number;
  users: number;
  policies: number;
  demoShoePrice: string | null;
  demoLaptopPrice: string | null;
  priyaPolicy: {
    maxAutonomousAmount: string;
    dailySpendingLimit: string;
    approvalThreshold: string;
    autonomousEnabled: boolean;
    maxAutonomousTxnsPerDay: number;
  } | null;
};

export async function truncateTransactionalTables(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TRANSACTIONAL_TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`,
  );
}

/** Remove test pollution outside the Phase 4/5 seed fixture set. */
export async function purgeNonSeedFixtures(): Promise<void> {
  const seedEmails = listSeedUserEmails();
  const seedMerchantIds = listSeedMerchantIds();
  const seedProductIds = listSeedProductIds();

  await prisma.user.deleteMany({
    where: { email: { notIn: seedEmails } },
  });

  await prisma.productAttribute.deleteMany({
    where: { productId: { notIn: seedProductIds } },
  });
  await prisma.product.deleteMany({
    where: { id: { notIn: seedProductIds } },
  });
  await prisma.merchant.deleteMany({
    where: { id: { notIn: seedMerchantIds } },
  });

  await prisma.financialPolicy.deleteMany({
    where: { user: { email: { notIn: seedEmails } } },
  });
}

export async function captureDemoSnapshot(): Promise<DemoSnapshot> {
  const [
    payments,
    webhookEvents,
    approvals,
    agentDecisions,
    agentRuns,
    policyEvaluations,
    orders,
    auditLogs,
    notifications,
    purchaseIntents,
    merchants,
    products,
    users,
    policies,
    shoe,
    laptop,
    priya,
  ] = await Promise.all([
    prisma.payment.count(),
    prisma.webhookEvent.count(),
    prisma.approval.count(),
    prisma.agentDecision.count(),
    prisma.agentRun.count(),
    prisma.policyEvaluation.count(),
    prisma.order.count(),
    prisma.auditLog.count(),
    prisma.notification.count(),
    prisma.purchaseIntent.count(),
    prisma.merchant.count(),
    prisma.product.count(),
    prisma.user.count(),
    prisma.financialPolicy.count(),
    prisma.product.findUnique({ where: { id: DEMO_SHOE_PRODUCT_ID }, select: { price: true } }),
    prisma.product.findUnique({ where: { id: DEMO_LAPTOP_PRODUCT_ID }, select: { price: true } }),
    prisma.user.findUnique({
      where: { email: "priya@commercepilot.demo" },
      include: { financialPolicy: true },
    }),
  ]);

  return {
    transactional: {
      payments,
      webhook_events: webhookEvents,
      approvals,
      agent_decisions: agentDecisions,
      agent_runs: agentRuns,
      policy_evaluations: policyEvaluations,
      orders,
      audit_logs: auditLogs,
      notifications,
      purchase_intents: purchaseIntents,
    },
    merchants,
    products,
    users,
    policies,
    demoShoePrice: shoe?.price.toFixed(2) ?? null,
    demoLaptopPrice: laptop?.price.toFixed(2) ?? null,
    priyaPolicy: priya?.financialPolicy
      ? {
          maxAutonomousAmount: priya.financialPolicy.maxAutonomousAmount.toFixed(2),
          dailySpendingLimit: priya.financialPolicy.dailySpendingLimit.toFixed(2),
          approvalThreshold: priya.financialPolicy.approvalThreshold.toFixed(2),
          autonomousEnabled: priya.financialPolicy.autonomousEnabled,
          maxAutonomousTxnsPerDay: priya.financialPolicy.maxAutonomousTxnsPerDay,
        }
      : null,
  };
}

export async function resetDemo(): Promise<SeedSummary> {
  await truncateTransactionalTables();
  await purgeNonSeedFixtures();
  return seedCatalog();
}

export function assertDemoSnapshotsEquivalent(a: DemoSnapshot, b: DemoSnapshot): void {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left !== right) {
    throw new Error(`Demo snapshots differ:\nA=${left}\nB=${right}`);
  }
}

export const CANONICAL_DEMO = {
  shoeId: DEMO_SHOE_PRODUCT_ID,
  shoePrice: DEMO_SHOE_PRICE,
  laptopId: DEMO_LAPTOP_PRODUCT_ID,
  laptopPrice: DEMO_LAPTOP_PRICE,
  priyaEmail: "priya@commercepilot.demo",
  users: 5,
  merchants: 4,
  products: 53,
  policies: 1,
  zeroTransactional: Object.fromEntries(
    TRANSACTIONAL_TABLES.map((t) => [t, 0]),
  ) as DemoSnapshot["transactional"],
};

async function main(): Promise<void> {
  const summary = await resetDemo();
  console.log(
    `Demo reset complete. Catalog: ${summary.merchants} merchants, ${summary.products} products, ${summary.users} users.`,
  );
  console.log(`Demo shoe ₹${summary.demoShoe.price}; demo laptop ₹${summary.demoLaptop.price}`);
  console.log("Transactional tables truncated; non-seed fixtures purged.");
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
