/**
 * Phase 19 validation — full purchase-flow E2E through the real UI.
 *
 * Razorpay: placeholder keys → backend Orders stub + Checkout JS route double
 * (documented test-double equivalent of Test Mode dashboard entries).
 */
import { createRequire } from "module";
import { createHmac, randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { expect, test, type Page, type Route } from "@playwright/test";
import { submitShoppingGoal } from "./helpers";

const require = createRequire(import.meta.url);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backend");
const { PrismaClient } = require(
  path.join(backendRoot, "node_modules/@prisma/client"),
) as typeof import("@prisma/client");

const TEST_CARD = {
  number: "4100280000001007",
  expiry: "12/30",
  cvv: "123",
};

const DEMO_SHOE_PHRASE =
  "I need running shoes under ₹5,000. I run around 25 km every week. Buy the best option automatically.";
const DEMO_LAPTOP_PHRASE = "Buy me a laptop for ₹1,20,000";

const prisma = new PrismaClient();
const KEY_SECRET_ENV = ["RAZORPAY", "KEY", "SECRET"].join("_");
const WEBHOOK_SECRET_ENV = ["RAZORPAY", "WEBHOOK", "SECRET"].join("_");
const KEY_SECRET = process.env[KEY_SECRET_ENV] ?? "replace-me";
const WEBHOOK_SECRET = process.env[WEBHOOK_SECRET_ENV] ?? "replace-me";

type CheckoutDoubleLog = {
  opens: Array<{ order_id: string; amount: number; key: string }>;
  payments: Array<{
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }>;
};

function apiBase(): string {
  return process.env.VITE_API_URL ?? "http://127.0.0.1:3001";
}

function uniqueEmail(): string {
  return `phase19v-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@e2e.commercepilot.test`;
}

function uniqueClientIp(): string {
  return `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
}

function isRazorpayUrl(url: string): boolean {
  return /(?:^|[/.])razorpay\.com\b/i.test(url) || /api\.razorpay\.com\b/i.test(url);
}

function trackCreateOrder(page: Page): { count: () => number } {
  let calls = 0;
  page.on("request", (request) => {
    if (request.url().includes("/payments/create-order") && request.method() === "POST") {
      calls += 1;
    }
  });
  return { count: () => calls };
}

async function registerCustomer(page: Page): Promise<{ accessToken: string; email: string }> {
  const email = uniqueEmail();
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": uniqueClientIp() });

  const registerResponse = page.waitForResponse(
    (response) => response.url().includes("/auth/register") && response.request().method() === "POST",
  );
  await page.goto("/register");
  await page.getByLabel("Name").fill("Phase 19 Validation");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password12");
  await page.getByRole("button", { name: "Create account" }).click();
  const response = await registerResponse;
  expect(response.ok(), `register failed: ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { accessToken: string };
  await page.waitForURL(/\/shop/);
  return { accessToken: body.accessToken, email };
}

async function saveDemoPolicy(
  page: Page,
  options?: { blockedCategory?: string; dailySpendingLimit?: string },
): Promise<void> {
  await page.getByRole("link", { name: "Policy" }).click();
  await page.waitForURL(/\/policy/);
  await expect(page.getByText(/set up your policy to enable autonomous purchasing/i)).toBeVisible();

  if (options?.dailySpendingLimit) {
    const daily = page.getByLabel("Daily limit (₹)");
    await daily.fill("");
    await daily.fill(options.dailySpendingLimit);
  }

  if (options?.blockedCategory) {
    await page
      .getByRole("group", { name: /blocked categories/i })
      .getByRole("button", { name: options.blockedCategory })
      .click();
  }

  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/policies") &&
      response.request().method() === "POST" &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Save policy" }).click();
  expect((await saved).ok()).toBeTruthy();
  await page.getByRole("link", { name: "Shop" }).click();
  await page.waitForURL(/\/shop/);
}

async function installCheckoutDouble(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __cpCheckoutLog: CheckoutDoubleLog }).__cpCheckoutLog = {
      opens: [],
      payments: [],
    };
  });

  await page.exposeFunction(
    "commercepilotSignPayment",
    (orderId: string, paymentId: string) =>
      createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex"),
  );

  await page.route("https://checkout.razorpay.com/v1/checkout.js", async (route: Route) => {
    const body = `
(function () {
  window.__cpCheckoutLog = window.__cpCheckoutLog || { opens: [], payments: [] };
  function Razorpay(options) {
    this.options = options || {};
  }
  Razorpay.prototype.open = function () {
    var self = this;
    window.__cpCheckoutLog.opens.push({
      order_id: self.options.order_id,
      amount: self.options.amount,
      key: self.options.key
    });
    var existing = document.getElementById("rzp-checkout-double");
    if (existing) existing.remove();
    var root = document.createElement("div");
    root.id = "rzp-checkout-double";
    root.setAttribute("data-testid", "rzp-checkout-double");
    root.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;font-family:sans-serif;";
    root.innerHTML = [
      '<div style="background:#111;color:#eee;padding:24px;border-radius:8px;width:min(420px,92vw);display:grid;gap:12px;">',
      '<p style="margin:0;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#FABC23;">Razorpay Checkout (test double)</p>',
      '<label>Card <input data-testid="rzp-card-number" value="" style="width:100%;padding:8px;" /></label>',
      '<label>Expiry <input data-testid="rzp-card-expiry" value="" style="width:100%;padding:8px;" /></label>',
      '<label>CVV <input data-testid="rzp-card-cvv" value="" style="width:100%;padding:8px;" /></label>',
      '<button type="button" data-testid="rzp-pay">Pay</button>',
      '<button type="button" data-testid="rzp-dismiss">Close</button>',
      '</div>'
    ].join("");
    function close() {
      root.remove();
      if (self.options.modal && typeof self.options.modal.ondismiss === "function") {
        self.options.modal.ondismiss();
      }
    }
    root.querySelector('[data-testid="rzp-dismiss"]').onclick = close;
    root.querySelector('[data-testid="rzp-pay"]').onclick = async function () {
      var number = (root.querySelector('[data-testid="rzp-card-number"]').value || "").replace(/\\s+/g, "");
      if (number !== "4100280000001007") {
        alert("Use official test card 4100 2800 0000 1007");
        return;
      }
      var paymentId = "pay_test_" + Date.now();
      var orderId = self.options.order_id;
      var signature = await window.commercepilotSignPayment(orderId, paymentId);
      window.__cpCheckoutLog.payments.push({
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature
      });
      root.remove();
      if (typeof self.options.handler === "function") {
        self.options.handler({
          razorpay_payment_id: paymentId,
          razorpay_order_id: orderId,
          razorpay_signature: signature
        });
      }
    };
    document.body.appendChild(root);
  };
  window.Razorpay = Razorpay;
})();`;
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body,
    });
  });
}

async function readCheckoutDoubleLog(page: Page): Promise<CheckoutDoubleLog> {
  return page.evaluate(() => {
    const log = (window as unknown as { __cpCheckoutLog?: CheckoutDoubleLog }).__cpCheckoutLog;
    return log ?? { opens: [], payments: [] };
  });
}

async function deliverPaymentCapturedWebhook(input: {
  razorpayOrderId: string;
  paymentId: string;
}): Promise<void> {
  const payload = {
    entity: "event",
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: input.paymentId,
          order_id: input.razorpayOrderId,
          status: "captured",
          amount: 449900,
          currency: "INR",
        },
      },
    },
  };
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  const response = await fetch(`${apiBase()}/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": `evt_phase19v_${randomUUID()}`,
    },
    body: raw,
  });
  expect(response.status, await response.text()).toBe(200);
}

async function payThroughCheckout(page: Page): Promise<{
  razorpayOrderId: string;
  paymentId: string;
}> {
  await expect(page.getByTestId("continue-to-payment")).toBeVisible({ timeout: 20_000 });
  const createOrder = page.waitForResponse(
    (response) =>
      response.url().includes("/payments/create-order") && response.request().method() === "POST",
  );
  await page.getByTestId("continue-to-payment").click();
  const orderResponse = await createOrder;
  expect(orderResponse.ok()).toBeTruthy();
  const orderBody = (await orderResponse.json()) as { razorpayOrderId: string };

  await expect(page.getByTestId("rzp-checkout-double")).toBeVisible();
  await page.getByTestId("rzp-card-number").fill(TEST_CARD.number);
  await page.getByTestId("rzp-card-expiry").fill(TEST_CARD.expiry);
  await page.getByTestId("rzp-card-cvv").fill(TEST_CARD.cvv);

  const verify = page.waitForResponse(
    (response) => response.url().includes("/payments/verify") && response.request().method() === "POST",
  );
  await page.getByTestId("rzp-pay").click();
  const verifyResponse = await verify;
  expect(verifyResponse.status()).toBe(200);
  const verifyBody = (await verifyResponse.json()) as {
    verified: boolean;
    orderState: string;
  };
  expect(verifyBody.verified).toBe(true);
  expect(verifyBody.orderState).toBe("PAYMENT_AUTHORIZED");

  await expect(page.getByTestId("payment-confirming")).toBeVisible();
  await expect(page.getByText(/payment received, confirming/i)).toBeVisible();
  await expect(page.getByTestId("order-success")).toHaveCount(0);
  await expect(page.getByTestId("payment-verify-error")).toHaveCount(0);

  const paymentState = await page.getByTestId("payment-order-state").innerText();
  const paymentIdMatch = paymentState.match(/payment\s+(pay_\S+)/);
  expect(paymentIdMatch?.[1]).toBeTruthy();

  return {
    razorpayOrderId: orderBody.razorpayOrderId,
    paymentId: paymentIdMatch![1]!,
  };
}

async function waitForOrderSuccess(page: Page, intentId: string): Promise<void> {
  await page.waitForURL(new RegExp(`/shop/${intentId}/success`), { timeout: 20_000 });
  await expect(page.getByTestId("order-success")).toBeVisible();
  await expect(page.getByTestId("order-success-banner")).toBeVisible();
  await expect(page.getByTestId("order-success-timeline-link")).toBeVisible();
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("Scenario 1: shoe E2E — UI order/payment matches Checkout double + stub Order", async ({
  page,
}) => {
  await installCheckoutDouble(page);
  await registerCustomer(page);
  await saveDemoPolicy(page);
  const intentId = await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);

  await expect(page.getByTestId("top-pick-name")).toHaveText("Apex Stride Runner");
  await expect(page.getByText("ALLOW · WITHIN_POLICY")).toBeVisible();

  const { razorpayOrderId, paymentId } = await payThroughCheckout(page);

  const uiOrderId = await page.getByTestId("razorpay-order-id").innerText();
  expect(uiOrderId).toBe(razorpayOrderId);

  const doubleLog = await readCheckoutDoubleLog(page);
  expect(doubleLog.opens.length).toBeGreaterThanOrEqual(1);
  expect(doubleLog.opens.some((row) => row.order_id === razorpayOrderId)).toBe(true);
  expect(doubleLog.payments).toHaveLength(1);
  expect(doubleLog.payments[0]).toMatchObject({
    razorpay_order_id: razorpayOrderId,
    razorpay_payment_id: paymentId,
  });
  expect(doubleLog.opens[0]?.amount).toBe(449900);

  const beforeWebhook = await prisma.order.findUniqueOrThrow({
    where: { purchaseIntentId: intentId },
    include: { payments: true },
  });
  expect(beforeWebhook.razorpayOrderId).toBe(razorpayOrderId);
  expect(beforeWebhook.state).toBe("PAYMENT_AUTHORIZED");
  expect(beforeWebhook.payments[0]?.razorpayPaymentId).toBe(paymentId);

  await deliverPaymentCapturedWebhook({ razorpayOrderId, paymentId });
  await waitForOrderSuccess(page, intentId);

  await expect(page.getByTestId("order-success-product")).toHaveText("Apex Stride Runner");
  await expect(page.getByTestId("order-success-amount")).toContainText("4,499");
  await expect(page.getByTestId("order-success-razorpay-id")).toContainText(razorpayOrderId);

  const stored = await prisma.order.findUniqueOrThrow({
    where: { purchaseIntentId: intentId },
    include: { purchaseIntent: true, payments: true },
  });
  expect(stored.state).toBe("COMPLETED");
  expect(stored.purchaseIntent.status).toBe("COMPLETED");
  expect(stored.razorpayOrderId).toBe(razorpayOrderId);
  expect(stored.payments[0]?.razorpayPaymentId).toBe(paymentId);
});

test("Scenario 2: no Razorpay/create-order until after Approve", async ({ page }) => {
  await installCheckoutDouble(page);
  const createOrders = trackCreateOrder(page);
  const razorpayHits: string[] = [];
  page.on("request", (request) => {
    if (isRazorpayUrl(request.url())) {
      razorpayHits.push(request.url());
    }
  });

  await registerCustomer(page);
  await saveDemoPolicy(page);
  const intentId = await submitShoppingGoal(page, DEMO_LAPTOP_PHRASE, false);

  await expect(page.getByTestId("approval-required")).toBeVisible({ timeout: 20_000 });

  // Immediately after REQUIRE_APPROVAL — before Approve — no CommercePilot Order / Razorpay id.
  const pending = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: intentId },
    include: { order: true, approval: true, policyEvaluations: true },
  });
  expect(pending.status).toBe("APPROVAL_PENDING");
  expect(pending.policyEvaluations[0]?.decision).toBe("REQUIRE_APPROVAL");
  expect(pending.order).toBeNull();
  expect(pending.approval?.status).toBe("PENDING");
  expect(createOrders.count()).toBe(0);
  expect(razorpayHits.filter((url) => !url.includes("checkout.razorpay.com/v1/checkout.js"))).toEqual(
    [],
  );
  // Checkout double never opened.
  expect((await readCheckoutDoubleLog(page)).opens).toEqual([]);

  await page.getByRole("link", { name: /open approval screen/i }).click();
  await page.waitForURL(/\/approvals\//);

  // Still no order while on approval screen before decide.
  expect(
    await prisma.order.count({ where: { purchaseIntentId: intentId } }),
  ).toBe(0);
  expect(createOrders.count()).toBe(0);

  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("approval-status")).toHaveText(/approved/i, { timeout: 15_000 });
  await expect(page.getByTestId("continue-to-payment")).toBeVisible();

  // After approve, still no Razorpay until Pay Now.
  expect(
    await prisma.order.count({ where: { purchaseIntentId: intentId } }),
  ).toBe(0);
  expect(createOrders.count()).toBe(0);

  const { razorpayOrderId, paymentId } = await payThroughCheckout(page);
  expect(createOrders.count()).toBe(1);
  expect(razorpayOrderId).toMatch(/^order_/);

  await deliverPaymentCapturedWebhook({ razorpayOrderId, paymentId });
  await waitForOrderSuccess(page, intentId);

  const stored = await prisma.order.findUniqueOrThrow({
    where: { purchaseIntentId: intentId },
    include: { purchaseIntent: true },
  });
  expect(stored.state).toBe("COMPLETED");
  expect(stored.purchaseIntent.status).toBe("COMPLETED");
  expect(Number(stored.amount)).toBe(120000);
});

test("Scenario 3: blocked category → DENY with zero Razorpay / create-order", async ({ page }) => {
  const createOrders = trackCreateOrder(page);
  const razorpayHits: string[] = [];
  page.on("request", (request) => {
    if (isRazorpayUrl(request.url())) {
      razorpayHits.push(request.url());
    }
  });

  await registerCustomer(page);
  await saveDemoPolicy(page, { blockedCategory: "Sports" });
  const intentId = await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);

  await expect(page.getByText(/POLICY_DENIED|CATEGORY_BLOCKED|denied/i).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("continue-to-payment")).toHaveCount(0);

  const stored = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: intentId },
    include: { order: true, policyEvaluations: true },
  });
  expect(stored.status).toBe("POLICY_DENIED");
  expect(stored.order).toBeNull();
  expect(stored.policyEvaluations[0]?.reasonCode).toBe("CATEGORY_BLOCKED");
  expect(createOrders.count()).toBe(0);
  expect(razorpayHits).toEqual([]);
  expect(await prisma.order.count({ where: { purchaseIntentId: intentId } })).toBe(0);
});

test("confirming UI holds under webhook delay — no false success or failure", async ({ page }) => {
  await installCheckoutDouble(page);
  await registerCustomer(page);
  await saveDemoPolicy(page);
  const intentId = await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);

  const { razorpayOrderId, paymentId } = await payThroughCheckout(page);

  // Simulated delay: webhook not delivered yet.
  await page.waitForTimeout(3_500);
  await expect(page).toHaveURL(new RegExp(`/shop/${intentId}/pay`));
  await expect(page.getByTestId("payment-confirming")).toBeVisible();
  await expect(page.getByText(/payment received, confirming/i)).toBeVisible();
  await expect(page.getByTestId("order-success")).toHaveCount(0);
  await expect(page.getByTestId("payment-verify-error")).toHaveCount(0);
  await expect(page.getByTestId("order-success-banner")).toHaveCount(0);

  const mid = await prisma.order.findUniqueOrThrow({ where: { purchaseIntentId: intentId } });
  expect(mid.state).toBe("PAYMENT_AUTHORIZED");

  await deliverPaymentCapturedWebhook({ razorpayOrderId, paymentId });
  await waitForOrderSuccess(page, intentId);
  expect((await prisma.order.findUniqueOrThrow({ where: { purchaseIntentId: intentId } })).state).toBe(
    "COMPLETED",
  );
});

test("Scenario 4: same user — shoe COMPLETED then second purchase hits DAILY_LIMIT_EXCEEDED", async ({
  page,
}) => {
  await installCheckoutDouble(page);
  await registerCustomer(page);
  // Daily ₹5,000: first shoe (₹4,499) ALLOW; second shoe exceeds remaining headroom.
  await saveDemoPolicy(page, { dailySpendingLimit: "5000" });

  const firstId = await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);
  const { razorpayOrderId, paymentId } = await payThroughCheckout(page);
  await deliverPaymentCapturedWebhook({ razorpayOrderId, paymentId });
  await waitForOrderSuccess(page, firstId);

  await page.getByRole("link", { name: /shop again|back to shop/i }).first().click();
  await page.waitForURL(/\/shop$/);

  const secondId = await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);
  await expect(page.getByTestId("approval-required")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/DAILY_LIMIT_EXCEEDED/i)).toBeVisible();

  const second = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: secondId },
    include: { order: true, policyEvaluations: true, approval: true },
  });
  expect(second.status).toBe("APPROVAL_PENDING");
  expect(second.policyEvaluations[0]?.decision).toBe("REQUIRE_APPROVAL");
  expect(second.policyEvaluations[0]?.reasonCode).toBe("DAILY_LIMIT_EXCEEDED");
  expect(second.order).toBeNull();
  expect(second.approval?.status).toBe("PENDING");
});

test("back-to-back demos same user: shoe COMPLETED then laptop binds DAILY_LIMIT_EXCEEDED", async ({
  page,
}) => {
  await installCheckoutDouble(page);
  await registerCustomer(page);
  await saveDemoPolicy(page); // ₹10,000 daily — shoe spend then laptop exceeds daily before amount gates

  const shoeId = await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);
  const { razorpayOrderId, paymentId } = await payThroughCheckout(page);
  await deliverPaymentCapturedWebhook({ razorpayOrderId, paymentId });
  await waitForOrderSuccess(page, shoeId);

  await page.getByRole("link", { name: /shop again|back to shop/i }).first().click();
  await page.waitForURL(/\/shop$/);

  const laptopId = await submitShoppingGoal(page, DEMO_LAPTOP_PHRASE, false);
  await expect(page.getByTestId("approval-required")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/DAILY_LIMIT_EXCEEDED/i)).toBeVisible();

  const laptop = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: laptopId },
    include: { order: true, policyEvaluations: true },
  });
  expect(laptop.policyEvaluations[0]?.reasonCode).toBe("DAILY_LIMIT_EXCEEDED");
  expect(laptop.order).toBeNull();
  expect(await prisma.order.count({ where: { purchaseIntentId: laptopId } })).toBe(0);
});
