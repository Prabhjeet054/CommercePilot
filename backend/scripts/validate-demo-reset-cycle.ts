/**
 * Phase 25 validation — demo:reset → Scenario 1 pipeline → demo:reset → DB snapshot.
 * Run: npx ts-node --transpile-only scripts/validate-demo-reset-cycle.ts
 */
import { createHmac, randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { setLLMProviderForTests } from "../src/lib/get-llm-provider";
import { MockLLMProvider } from "../src/lib/providers/mock-provider";
import { prisma } from "../src/lib/prisma";
import { DEMO_SHOE_PRICE, DEMO_SHOE_PRODUCT_ID } from "../src/modules/catalog/catalog.constants";
import { buildIntentPrompt, DEMO_INTENT_PHRASE } from "../src/modules/intent/intent-agent";
import {
  setRazorpayClientForTests,
  type RazorpayOrdersClient,
} from "../src/modules/payments/razorpay-client";
import {
  CANONICAL_DEMO,
  captureDemoSnapshot,
  resetDemo,
} from "../prisma/reset-demo";

process.env.RAZORPAY_KEY_ID = "rzp_test_validate_demo";
process.env.RAZORPAY_KEY_SECRET = "validate-demo-secret";
process.env.PURCHASE_INTENT_RATE_LIMIT_MAX = "100";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET: "validate-demo-access-secret!",
  JWT_REFRESH_SECRET: "validate-demo-refresh-secret",
  NODE_ENV: "test",
});

const razorpay: RazorpayOrdersClient = {
  async createOrder(input) {
    return { id: `order_val_${randomUUID().slice(0, 8)}`, amount: input.amount, currency: input.currency };
  },
  async fetchOrder(id) {
    return { id, status: "created" };
  },
  async fetchOrderPayments() {
    return [];
  },
};

async function main() {
  setRazorpayClientForTests(razorpay);
  setLLMProviderForTests(
    new MockLLMProvider({
      fixtures: {
        [buildIntentPrompt(DEMO_INTENT_PHRASE)]: {
          category: "running_shoes",
          budget: 5000,
          currency: "INR",
          purpose: "running shoes",
          usage: "25 km every week",
          priority: "best",
          purchaseMode: "autonomous",
          hasAdditionalUnparsedRequest: false,
        },
      },
    }),
  );

  console.log("1) demo:reset");
  await resetDemo();
  const before = await captureDemoSnapshot();
  console.log("canonical before scenario:", JSON.stringify(before.transactional));

  const login = await request(app)
    .post("/auth/login")
    .set("X-Forwarded-For", "203.0.113.200")
    .send({ email: "priya@commercepilot.demo", password: "password12" });
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  const token = login.body.accessToken as string;

  console.log("2) Scenario 1 — shoe purchase intent → create-order → verify");
  const intent = await request(app)
    .post("/purchase-intents")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Forwarded-For", "203.0.113.201")
    .send({ text: DEMO_INTENT_PHRASE, purchaseMode: "autonomous" });
  if (intent.status !== 201) {
    throw new Error(`intent failed: ${intent.status} ${JSON.stringify(intent.body)}`);
  }
  console.log("intent", intent.body.status, intent.body.selectedProduct?.id, intent.body.selectedProduct?.price);

  const created = await request(app)
    .post("/payments/create-order")
    .set("Authorization", `Bearer ${token}`)
    .send({ purchaseIntentId: intent.body.id });
  if (created.status !== 200) {
    throw new Error(`create-order failed: ${created.status} ${JSON.stringify(created.body)}`);
  }

  const paymentId = `pay_val_${randomUUID().slice(0, 8)}`;
  const signature = createHmac("sha256", "validate-demo-secret")
    .update(`${created.body.razorpayOrderId}|${paymentId}`)
    .digest("hex");
  const verified = await request(app)
    .post("/payments/verify")
    .set("Authorization", `Bearer ${token}`)
    .send({
      razorpay_order_id: created.body.razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    });
  if (verified.status !== 200) {
    throw new Error(`verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }
  console.log("verify", verified.body);

  const dirty = await captureDemoSnapshot();
  if (dirty.transactional.purchase_intents < 1 || dirty.transactional.orders < 1) {
    throw new Error("expected transactional rows after scenario 1");
  }
  console.log("dirty transactional:", JSON.stringify(dirty.transactional));

  console.log("3) demo:reset again");
  await resetDemo();
  const after = await captureDemoSnapshot();

  const ok =
    JSON.stringify(after.transactional) === JSON.stringify(CANONICAL_DEMO.zeroTransactional) &&
    after.demoShoePrice === DEMO_SHOE_PRICE &&
    after.demoLaptopPrice === CANONICAL_DEMO.laptopPrice &&
    after.users === CANONICAL_DEMO.users &&
    after.merchants === CANONICAL_DEMO.merchants &&
    after.products === CANONICAL_DEMO.products &&
    after.policies === CANONICAL_DEMO.policies &&
    JSON.stringify(after.priyaPolicy) === JSON.stringify(before.priyaPolicy);

  console.log("after reset:", JSON.stringify({
    transactional: after.transactional,
    users: after.users,
    merchants: after.merchants,
    products: after.products,
    policies: after.policies,
    shoe: after.demoShoePrice,
    laptop: after.demoLaptopPrice,
    priyaPolicy: after.priyaPolicy,
  }));

  if (!ok) {
    throw new Error("post-reset snapshot not canonical");
  }
  if (after.transactional.purchase_intents !== 0) {
    throw new Error("purchase_intents not empty");
  }
  const shoe = await prisma.product.findUniqueOrThrow({ where: { id: DEMO_SHOE_PRODUCT_ID } });
  if (shoe.price.toFixed(2) !== DEMO_SHOE_PRICE) {
    throw new Error("shoe price drifted");
  }
  console.log("PASS: demo reset cycle restored canonical demo state");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    setRazorpayClientForTests(null);
    setLLMProviderForTests(null);
    await prisma.$disconnect();
  });
