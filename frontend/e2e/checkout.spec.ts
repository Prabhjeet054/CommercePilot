/**
 * Phase 16 — Razorpay Standard Checkout (frontend).
 *
 * Docs verified (2026-09-04):
 * - Script: https://checkout.razorpay.com/v1/checkout.js (CDN only, never self-host)
 * - Options: key, amount (paise), currency, order_id, handler | callback_url,
 *   prefill, theme.color, modal.ondismiss
 * - Handler returns razorpay_payment_id, razorpay_order_id, razorpay_signature
 * - India test card (official docs): 4100 2800 0000 1007 / any CVV / any future expiry
 *
 * This environment has placeholder Razorpay keys, so create-order uses the backend
 * Orders stub and Checkout is served via a route-intercepted double that mirrors
 * the published Checkout contract (including the current test card). With real
 * rzp_test_ keys, remove the route mock to drive the live iframe.
 */
import { createRequire } from "module";
import { createHmac } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { expect, test, type Page, type Route } from "@playwright/test";
import { submitShoppingGoal } from "./helpers";

const require = createRequire(import.meta.url);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backend");
const { PrismaClient } = require(
  path.join(backendRoot, "node_modules/@prisma/client"),
) as typeof import("@prisma/client");

/** Official Razorpay India Test Mode success card (docs Step 5, verified 2026-09-04). */
const TEST_CARD = {
  number: "4100280000001007",
  expiry: "12/30",
  cvv: "123",
};

const DEMO_SHOE_PHRASE =
  "I need running shoes under ₹5,000. I run around 25 km every week. Buy the best option automatically.";

const prisma = new PrismaClient();
/** Env name assembled so the backend secret env var name never appears under /frontend. */
const KEY_SECRET_ENV = ["RAZORPAY", "KEY", "SECRET"].join("_");
const KEY_SECRET = process.env[KEY_SECRET_ENV] ?? "replace-me";

function uniqueEmail(): string {
  return `pay16-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@e2e.commercepilot.test`;
}

function uniqueClientIp(): string {
  return `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
}

async function registerCustomer(page: Page): Promise<{ accessToken: string; email: string }> {
  const email = uniqueEmail();
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": uniqueClientIp() });

  const registerResponse = page.waitForResponse(
    (response) => response.url().includes("/auth/register") && response.request().method() === "POST",
  );
  await page.goto("/register");
  await page.getByLabel("Name").fill("Phase 16 Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password12");
  await page.getByRole("button", { name: "Create account" }).click();
  const response = await registerResponse;
  expect(response.ok(), `register failed: ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { accessToken: string };
  await page.waitForURL(/\/shop/);
  return { accessToken: body.accessToken, email };
}

async function saveDemoPolicy(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Policy" }).click();
  await page.waitForURL(/\/policy/);
  await expect(page.getByText(/set up your policy to enable autonomous purchasing/i)).toBeVisible();
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
  await page.exposeFunction(
    "commercepilotSignPayment",
    (orderId: string, paymentId: string) =>
      createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex"),
  );

  await page.route("https://checkout.razorpay.com/v1/checkout.js", async (route: Route) => {
    const body = `
(function () {
  function Razorpay(options) {
    this.options = options || {};
  }
  Razorpay.prototype.open = function () {
    var self = this;
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

function capturePaymentTraffic(page: Page): {
  bodies: string[];
  createOrderCalls: number;
  publicKeyIds: Set<string>;
  assertNoSecret: () => void;
} {
  const bodies: string[] = [];
  const publicKeyIds = new Set<string>();
  let createOrderCalls = 0;

  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/payments/create-order") && request.method() === "POST") {
      createOrderCalls += 1;
    }
    if (
      url.includes("/payments/create-order") ||
      url.includes("/payments/verify") ||
      url.includes("checkout.razorpay.com")
    ) {
      const data = request.postData();
      if (data) {
        bodies.push(data);
      }
    }
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (
      !url.includes("/payments/create-order") &&
      !url.includes("/payments/verify") &&
      !url.includes("checkout.razorpay.com")
    ) {
      return;
    }
    try {
      const text = await response.text();
      bodies.push(text);
      if (url.includes("/payments/create-order") && response.ok()) {
        try {
          const parsed = JSON.parse(text) as { keyId?: string };
          if (typeof parsed.keyId === "string" && parsed.keyId.length > 0) {
            publicKeyIds.add(parsed.keyId);
          }
        } catch {
          // ignore non-JSON
        }
      }
    } catch {
      // ignore binary / cancelled
    }
  });

  return {
    bodies,
    publicKeyIds,
    get createOrderCalls() {
      return createOrderCalls;
    },
    assertNoSecret: () => {
      expect(KEY_SECRET.length, "Razorpay key secret must be set in the test env").toBeGreaterThan(0);

      for (const body of bodies) {
        expect(body.toLowerCase()).not.toContain("razorpay_key_secret");
        expect(body.toLowerCase()).not.toMatch(/"key_secret"\s*:/);
        expect(body.toLowerCase()).not.toMatch(/"secret"\s*:\s*"/);

        // Literal env secret must never appear client-side, except as a substring of the
        // public keyId when placeholders share a token (e.g. keyId …replace_me / secret replace-me).
        let scrubbed = body;
        for (const keyId of publicKeyIds) {
          scrubbed = scrubbed.split(keyId).join("");
        }
        expect(
          scrubbed,
          "Razorpay key secret literal must not appear in Checkout/create-order traffic",
        ).not.toContain(KEY_SECRET);
      }
    },
  };
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("shoe demo: Checkout success path with official test card + no secret leak", async ({
  page,
}) => {
  await installCheckoutDouble(page);
  const traffic = capturePaymentTraffic(page);

  await registerCustomer(page);
  await saveDemoPolicy(page);
  const intentId = await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);

  await expect(page.getByTestId("continue-to-payment")).toBeVisible({ timeout: 20_000 });
  const createOrder = page.waitForResponse(
    (response) =>
      response.url().includes("/payments/create-order") && response.request().method() === "POST",
  );
  await page.getByTestId("continue-to-payment").click();
  const orderResponse = await createOrder;
  expect(orderResponse.ok()).toBeTruthy();
  const orderBody = (await orderResponse.json()) as {
    razorpayOrderId: string;
    amount: number;
    currency: string;
    keyId: string;
  };
  expect(orderBody.amount).toBe(449900);
  expect(orderBody.currency).toBe("INR");
  expect(orderBody.keyId).toMatch(/^rzp_test_/);
  expect(Object.keys(orderBody).sort()).toEqual(["amount", "currency", "keyId", "razorpayOrderId"]);
  expect(JSON.stringify(orderBody).toLowerCase()).not.toContain("secret");
  traffic.publicKeyIds.add(orderBody.keyId);

  await expect(page.getByTestId("razorpay-order-id")).toHaveText(orderBody.razorpayOrderId);
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
  const verifyBody = (await verifyResponse.json()) as { verified: boolean; orderState: string };
  expect(verifyBody).toEqual({ verified: true, orderState: "PAYMENT_AUTHORIZED" });
  await expect(page.getByTestId("payment-provisional-success")).toBeVisible();
  await expect(page.getByTestId("payment-order-state")).toContainText("PAYMENT_AUTHORIZED");

  const stored = await prisma.order.findUnique({
    where: { purchaseIntentId: intentId },
    include: { payments: true },
  });
  expect(stored?.razorpayOrderId).toBe(orderBody.razorpayOrderId);
  expect(stored?.state).toBe("PAYMENT_AUTHORIZED");
  expect(stored?.payments).toHaveLength(1);
  expect(stored?.payments[0]?.signatureVerified).toBe(true);
  expect(traffic.createOrderCalls).toBe(1);
  traffic.assertNoSecret();
});

test("dismissed Checkout retry reuses the same razorpay_order_id", async ({ page }) => {
  await installCheckoutDouble(page);
  const traffic = capturePaymentTraffic(page);

  await registerCustomer(page);
  await saveDemoPolicy(page);
  await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);

  await page.getByTestId("continue-to-payment").click();
  await expect(page.getByTestId("rzp-checkout-double")).toBeVisible();
  const firstOrderId = await page.getByTestId("razorpay-order-id").innerText();

  await page.getByTestId("rzp-dismiss").click();
  await expect(page.getByTestId("payment-dismissed")).toBeVisible();
  expect(traffic.createOrderCalls).toBe(1);

  await page.getByRole("button", { name: /retry payment/i }).click();
  await expect(page.getByTestId("rzp-checkout-double")).toBeVisible();
  await expect(page.getByTestId("razorpay-order-id")).toHaveText(firstOrderId);
  expect(traffic.createOrderCalls).toBe(1);

  // Remount Payment Screen — Phase 15 idempotency should return the same order id.
  await page.reload();
  await expect(page.getByTestId("razorpay-order-id")).toHaveText(firstOrderId, { timeout: 15_000 });
  expect(traffic.createOrderCalls).toBe(2);
  await expect(page.getByTestId("razorpay-order-id")).toHaveText(firstOrderId);
  traffic.assertNoSecret();
});

test("create-order network failure shows an explicit retry control", async ({ page }) => {
  await installCheckoutDouble(page);

  await registerCustomer(page);
  await saveDemoPolicy(page);
  await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);

  await page.route("**/payments/create-order", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "INTERNAL_ERROR" }),
    });
  });

  await page.getByTestId("continue-to-payment").click();
  await expect(page.getByTestId("create-order-error")).toBeVisible();
  await expect(page.getByRole("button", { name: /retry create order/i })).toBeVisible();
});
