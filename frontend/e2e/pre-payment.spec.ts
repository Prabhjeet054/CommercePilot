/**
 * Phase 14 — Pre-payment E2E gate (PRD §39 M3).
 *
 * Prompt path `/tests/e2e/pre-payment.spec.ts` maps here because this repo's
 * Playwright suite already lives under `frontend/e2e` (see playwright.config.ts).
 *
 * Already proven in isolation (do not re-test here):
 * - Phase 10 API: shoe ALLOW, laptop REQUIRE_APPROVAL, blocked DENY, zero Orders
 * - Phase 11/12 UI: seeded Priya shoe + laptop reject (no register, no policy setup, no approve)
 * - Phase 12 API: approval consume / replay / IDOR
 * - Phase 13: state machine + internal Order factory (not called by this pipeline)
 *
 * This spec proves the *cross-phase* customer path: register → demo policy →
 * intent → ranking → policy → approve/reject/deny, and that Razorpay is untouched.
 *
 * LLM trade-off: Playwright starts the API with LLM_PROVIDER=mock (same as the
 * existing frontend e2e). Intent Agent + Ranking Engine + Policy Engine still
 * run for real; only the vendor HTTP call is replaced with the demo-phrase
 * fixtures. Live OpenAI would make this gate flaky and spend tokens in CI.
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { expect, test, type Page } from "@playwright/test";
import { submitShoppingGoal } from "./helpers";

const require = createRequire(import.meta.url);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backend");
const { PrismaClient } = require(
  path.join(backendRoot, "node_modules/@prisma/client"),
) as typeof import("@prisma/client");

const DEMO_SHOE_PHRASE =
  "I need running shoes under ₹5,000. I run around 25 km every week. Buy the best option automatically.";
const DEMO_LAPTOP_PHRASE = "Buy me a laptop for ₹1,20,000";

const prisma = new PrismaClient();

function apiBase(): string {
  return process.env.VITE_API_URL ?? "http://127.0.0.1:3001";
}

function uniqueEmail(): string {
  return `prepay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@e2e.commercepilot.test`;
}

function uniqueClientIp(): string {
  return `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
}

function isRazorpayUrl(url: string): boolean {
  return /(?:^|[/.])razorpay\.com\b/i.test(url) || /api\.razorpay\.com/i.test(url);
}

function watchRazorpay(page: Page): { assertNone: () => void } {
  const hits: string[] = [];
  page.on("request", (request) => {
    if (isRazorpayUrl(request.url())) {
      hits.push(request.url());
    }
  });
  return {
    assertNone: () => {
      expect(hits, `unexpected Razorpay request(s): ${hits.join(", ")}`).toEqual([]);
    },
  };
}

async function registerCustomer(page: Page): Promise<{
  accessToken: string;
  userId: string;
  email: string;
}> {
  const email = uniqueEmail();
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": uniqueClientIp() });

  const registerResponse = page.waitForResponse(
    (response) => response.url().includes("/auth/register") && response.request().method() === "POST",
  );
  await page.goto("/register");
  await page.getByLabel("Name").fill("Pre-payment Gate");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password12");
  await page.getByRole("button", { name: "Create account" }).click();
  const response = await registerResponse;
  expect(response.ok(), `register failed: ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as {
    accessToken: string;
    user: { id: string };
  };
  await page.waitForURL(/\/shop/);
  return { accessToken: body.accessToken, userId: body.user.id, email };
}

async function saveDemoPolicy(page: Page, blockedCategory?: string): Promise<void> {
  await page.getByRole("link", { name: "Policy" }).click();
  await page.waitForURL(/\/policy/);
  await expect(page.getByText(/set up your policy to enable autonomous purchasing/i)).toBeVisible();
  await expect(page.getByLabel("Max autonomous (₹)")).toHaveValue("5000");
  await expect(page.getByLabel("Daily limit (₹)")).toHaveValue("10000");
  await expect(page.getByLabel("Approval threshold (₹)")).toHaveValue("5000");

  if (blockedCategory) {
    await page.getByRole("group", { name: /blocked categories/i }).getByRole("button", { name: blockedCategory }).click();
  }

  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/policies") &&
      response.request().method() === "POST" &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Save policy" }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.getByText(/autonomous purchases up to/i)).toBeVisible();
  await page.getByRole("link", { name: "Shop" }).click();
  await page.waitForURL(/\/shop/);
}

async function getIntent(accessToken: string, intentId: string): Promise<{
  status: string;
  orderCount: number;
  policyEvaluations: Array<{ decision: string; reasonCode: string }>;
  approval: { id: string; status: string; reasonCode: string | null } | null;
  agentRun: { decisions: Array<{ selected: boolean; productId: string; name: string }> } | null;
}> {
  const response = await fetch(`${apiBase()}/purchase-intents/${intentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(response.ok).toBeTruthy();
  return (await response.json()) as Awaited<ReturnType<typeof getIntent>>;
}

async function assertNoPopulatedRazorpayOrderId(userId: string, intentId: string): Promise<void> {
  const populated = await prisma.order.count({
    where: {
      razorpayOrderId: { not: null },
      OR: [{ purchaseIntentId: intentId }, { purchaseIntent: { userId } }],
    },
  });
  expect(populated, "Order.razorpayOrderId must not be populated").toBe(0);
}

test.describe.configure({ mode: "serial", timeout: 90_000 });

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("A: register → demo policy → shoe intent reaches POLICY_ALLOWED / ALLOW", async ({ page }) => {
  const razorpay = watchRazorpay(page);
  const { accessToken, userId } = await registerCustomer(page);
  await saveDemoPolicy(page);
  const intentId = await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);

  await expect(page.getByTestId("top-pick-name")).toHaveText("Apex Stride Runner");
  await expect(page.getByText(/₹4,499/).first()).toBeVisible();
  await expect(page.getByText("ALLOW · WITHIN_POLICY")).toBeVisible();
  await expect(page.getByText(/policy allowed this purchase/i)).toBeVisible();
  await expect(page.getByText(/continue to payment when you are ready/i)).toBeVisible();
  await expect(page.getByTestId("continue-to-payment")).toBeVisible();

  const stored = await getIntent(accessToken, intentId);
  expect(stored.status).toBe("POLICY_ALLOWED");
  expect(stored.orderCount).toBe(0);
  expect(stored.approval).toBeNull();
  expect(stored.policyEvaluations).toHaveLength(1);
  expect(stored.policyEvaluations[0]).toMatchObject({
    decision: "ALLOW",
    reasonCode: "WITHIN_POLICY",
  });
  expect(stored.agentRun?.decisions.some((row) => row.selected && row.name === "Apex Stride Runner")).toBe(
    true,
  );

  const db = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: intentId },
    include: { order: true, approval: true, policyEvaluations: true },
  });
  expect(db.userId).toBe(userId);
  expect(db.status).toBe("POLICY_ALLOWED");
  expect(db.status).not.toBe("ORDER_CREATED");
  expect(db.order).toBeNull();
  expect(db.approval).toBeNull();
  expect(db.policyEvaluations[0]?.decision).toBe("ALLOW");
  expect(db.policyEvaluations[0]?.reasonCode).toBe("WITHIN_POLICY");
  expect(await prisma.order.count({ where: { purchaseIntentId: intentId } })).toBe(0);
  await assertNoPopulatedRazorpayOrderId(userId, intentId);
  razorpay.assertNone();
});

test("B: register → demo policy → laptop intent → APPROVAL_PENDING → approve → APPROVED", async ({
  page,
}) => {
  const razorpay = watchRazorpay(page);
  const { accessToken, userId } = await registerCustomer(page);
  await saveDemoPolicy(page);
  const intentId = await submitShoppingGoal(page, DEMO_LAPTOP_PHRASE, false);

  await expect(page.getByTestId("approval-required")).toHaveText("Approval required");
  await expect(page.getByText("REQUIRE_APPROVAL · DAILY_LIMIT_EXCEEDED")).toBeVisible();
  await expect(page.getByTestId("top-pick-name")).toHaveText(/Nova Ultrabook/);
  await expect(page.getByText(/₹1,20,000/).first()).toBeVisible();

  const pending = await getIntent(accessToken, intentId);
  expect(pending.status).toBe("APPROVAL_PENDING");
  expect(pending.orderCount).toBe(0);
  expect(pending.policyEvaluations[0]).toMatchObject({
    decision: "REQUIRE_APPROVAL",
    reasonCode: "DAILY_LIMIT_EXCEEDED",
  });
  expect(pending.approval?.status).toBe("PENDING");
  expect(pending.approval?.reasonCode).toBe("DAILY_LIMIT_EXCEEDED");
  const approvalId = pending.approval?.id;
  expect(approvalId).toBeTruthy();

  await page.getByRole("link", { name: /open approval screen/i }).click();
  await page.waitForURL(new RegExp(`/approvals/${approvalId}`));
  await expect(page.getByRole("heading", { name: /Nova Ultrabook/i })).toBeVisible();
  await expect(page.getByText("DAILY_LIMIT_EXCEEDED")).toBeVisible();

  await page.getByRole("button", { name: /^approve$/i }).click();
  await expect(page.getByTestId("approval-status")).toHaveText(/approved/i);
  await expect(page.getByRole("button", { name: /^approve$/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^reject$/i })).toBeDisabled();

  const approved = await getIntent(accessToken, intentId);
  expect(approved.status).toBe("APPROVED");
  expect(approved.status).not.toBe("ORDER_CREATED");
  expect(approved.orderCount).toBe(0);
  expect(approved.approval?.status).toBe("APPROVED");
  expect(approved.approval?.reasonCode).toBe("DAILY_LIMIT_EXCEEDED");
  expect(approved.policyEvaluations[0]).toMatchObject({
    decision: "REQUIRE_APPROVAL",
    reasonCode: "DAILY_LIMIT_EXCEEDED",
  });

  await page.goto(`/shop/${intentId}/review`);
  await expect(page.getByText(/you approved this purchase/i)).toBeVisible();
  await expect(page.getByText(/continue to payment/i)).toBeVisible();
  await expect(page.getByTestId("continue-to-payment")).toBeVisible();

  const db = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: intentId },
    include: { order: true, approval: true },
  });
  expect(db.status).toBe("APPROVED");
  expect(db.status).not.toBe("ORDER_CREATED");
  expect(db.order).toBeNull();
  expect(db.approval?.status).toBe("APPROVED");
  expect(db.approval?.reasonCode).toBe("DAILY_LIMIT_EXCEEDED");
  expect(db.approval?.consumedAt).not.toBeNull();
  expect(await prisma.order.count({ where: { purchaseIntentId: intentId } })).toBe(0);
  await assertNoPopulatedRazorpayOrderId(userId, intentId);
  razorpay.assertNone();
});

test("C: register → demo policy → laptop intent → reject → APPROVAL_REJECTED, pipeline halts", async ({
  page,
}) => {
  const razorpay = watchRazorpay(page);
  const { accessToken, userId } = await registerCustomer(page);
  await saveDemoPolicy(page);
  const intentId = await submitShoppingGoal(page, DEMO_LAPTOP_PHRASE, false);

  await expect(page.getByText("REQUIRE_APPROVAL · DAILY_LIMIT_EXCEEDED")).toBeVisible();
  const pending = await getIntent(accessToken, intentId);
  expect(pending.status).toBe("APPROVAL_PENDING");
  expect(pending.policyEvaluations[0]).toMatchObject({
    decision: "REQUIRE_APPROVAL",
    reasonCode: "DAILY_LIMIT_EXCEEDED",
  });
  const beforeRuns = await prisma.agentRun.count({ where: { purchaseIntentId: intentId } });

  await page.getByRole("link", { name: /open approval screen/i }).click();
  await page.waitForURL(/\/approvals\/[0-9a-f-]+/i);
  await page.getByRole("button", { name: /^reject$/i }).click();
  await expect(page.getByTestId("approval-status")).toHaveText(/rejected/i);
  await expect(page.getByRole("button", { name: /^approve$/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^reject$/i })).toBeDisabled();

  const rejected = await getIntent(accessToken, intentId);
  expect(rejected.status).toBe("APPROVAL_REJECTED");
  expect(rejected.status).not.toBe("ORDER_CREATED");
  expect(rejected.orderCount).toBe(0);
  expect(rejected.approval?.status).toBe("REJECTED");
  expect(rejected.approval?.reasonCode).toBe("DAILY_LIMIT_EXCEEDED");

  await page.goto(`/shop/${intentId}/review`);
  await expect(page.getByText(/you rejected this purchase/i)).toBeVisible();
  await expect(page.getByText(/no order was created/i)).toBeVisible();

  const db = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: intentId },
    include: { order: true, approval: true },
  });
  expect(db.status).toBe("APPROVAL_REJECTED");
  expect(db.status).not.toBe("ORDER_CREATED");
  expect(db.order).toBeNull();
  expect(db.approval?.status).toBe("REJECTED");
  expect(db.approval?.reasonCode).toBe("DAILY_LIMIT_EXCEEDED");
  expect(await prisma.order.count({ where: { purchaseIntentId: intentId } })).toBe(0);
  expect(await prisma.approval.count({ where: { purchaseIntentId: intentId } })).toBe(1);
  expect(await prisma.agentRun.count({ where: { purchaseIntentId: intentId } })).toBe(beforeRuns);
  await assertNoPopulatedRazorpayOrderId(userId, intentId);
  razorpay.assertNone();
});

test("D: blocked-category intent reaches POLICY_DENIED with zero Order/Approval side effects", async ({
  page,
}) => {
  const razorpay = watchRazorpay(page);
  const { accessToken, userId } = await registerCustomer(page);
  await saveDemoPolicy(page, "Sports");
  const intentId = await submitShoppingGoal(page, DEMO_SHOE_PHRASE, true);

  await expect(page.getByText("DENY · CATEGORY_BLOCKED")).toBeVisible();
  await expect(page.getByText(/policy denied this purchase/i)).toBeVisible();
  await expect(page.getByText(/no order was created/i)).toBeVisible();
  await expect(page.getByTestId("top-pick-name")).toHaveText("Apex Stride Runner");
  await expect(page.getByRole("link", { name: /open approval screen/i })).toHaveCount(0);

  const stored = await getIntent(accessToken, intentId);
  expect(stored.status).toBe("POLICY_DENIED");
  expect(stored.orderCount).toBe(0);
  expect(stored.approval).toBeNull();
  expect(stored.policyEvaluations[0]).toMatchObject({
    decision: "DENY",
    reasonCode: "CATEGORY_BLOCKED",
  });
  expect(stored.agentRun?.decisions.some((row) => row.selected)).toBe(true);

  const db = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: intentId },
    include: { order: true, approval: true, agentRun: true, policyEvaluations: true },
  });
  expect(db.status).toBe("POLICY_DENIED");
  expect(db.status).not.toBe("ORDER_CREATED");
  expect(db.order).toBeNull();
  expect(db.approval).toBeNull();
  expect(db.agentRun).not.toBeNull();
  expect(db.policyEvaluations[0]?.decision).toBe("DENY");
  expect(db.policyEvaluations[0]?.reasonCode).toBe("CATEGORY_BLOCKED");
  expect(await prisma.order.count({ where: { purchaseIntent: { userId } } })).toBe(0);
  expect(await prisma.approval.count({ where: { userId } })).toBe(0);
  await assertNoPopulatedRazorpayOrderId(userId, intentId);
  razorpay.assertNone();
});
