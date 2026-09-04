import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { expect, test } from "@playwright/test";
import {
  DEMO_INTENT_PHRASE,
  DEMO_LAPTOP_PHRASE,
  LOW_BUDGET_SPORTS_PHRASE,
} from "../src/lib/api/purchase-intents";
import { loginAsDemoCustomer, submitShoppingGoal } from "./helpers";

const require = createRequire(import.meta.url);
const backendPrisma = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backend/node_modules/@prisma/client");
const { PrismaClient } = require(backendPrisma) as typeof import("@prisma/client");

type Factor = { name: string; score: number; weight: number; evidence: string };

function apiBase(): string {
  return process.env.VITE_API_URL ?? "http://127.0.0.1:3001";
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const prisma = new PrismaClient();
  try {
    const priya = await prisma.user.findUnique({ where: { email: "priya@commercepilot.demo" } });
    expect(priya, "seeded demo customer priya@commercepilot.demo").toBeTruthy();
    const policy = await prisma.financialPolicy.findUnique({ where: { userId: priya!.id } });
    expect(policy, "seeded demo financial policy").toBeTruthy();
  } finally {
    await prisma.$disconnect();
  }
});

test("demo phrase selects the ₹4,499 shoe and shows an allowed autonomous result", async ({ page }) => {
  const accessToken = await loginAsDemoCustomer(page);
  const intentId = await submitShoppingGoal(page, DEMO_INTENT_PHRASE, true);

  await expect(page.getByTestId("top-pick-name")).toHaveText("Apex Stride Runner");
  await expect(page.getByText(/₹4,499/).first()).toBeVisible();
  await expect(page.getByText("ALLOW · WITHIN_POLICY")).toBeVisible();
  await expect(page.getByText(/continuing automatically/i)).toBeVisible();
  await expect(page.getByText(/policy allowed this purchase/i)).toBeVisible();

  await page.getByRole("link", { name: "Open comparison" }).click();
  await page.waitForURL(new RegExp(`/shop/${intentId}/compare`));
  await page.getByTestId("top-pick-name").click();

  const stored = await fetch(`${apiBase()}/purchase-intents/${intentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(stored.ok).toBeTruthy();
  const apiBody = (await stored.json()) as {
    agentRun: {
      decisions: Array<{
        selected: boolean;
        score: string | null;
        productId: string;
        factors: Factor[];
        scoreBreakdown: Factor[];
      }>;
    };
  };
  const selected = apiBody.agentRun.decisions.find((row) => row.selected);
  expect(selected).toBeTruthy();
  expect(await page.getByTestId("top-pick-score").textContent()).toBe(Number(selected!.score).toFixed(2));

  const prisma = new PrismaClient();
  try {
    const db = await prisma.agentDecision.findFirstOrThrow({
      where: { selected: true, agentRun: { purchaseIntentId: intentId } },
    });
    expect(db.score?.toFixed(2)).toBe(Number(selected!.score).toFixed(2));
    const breakdown = db.scoreBreakdown as Factor[];
    for (const factor of breakdown) {
      await expect(page.getByTestId(`factor-score-${selected!.productId}-${factor.name}`)).toHaveText(
        Number(factor.score).toFixed(2),
      );
      await expect(page.getByTestId(`evidence-${selected!.productId}-${factor.name}`)).toHaveText(factor.evidence);
    }
  } finally {
    await prisma.$disconnect();
  }

  const html = await page.content();
  expect(html).not.toContain(accessToken);
  const local = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
    cookie: document.cookie,
  }));
  expect(JSON.stringify(local)).not.toContain(accessToken);
  expect(local.cookie).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
});

test("laptop phrase opens a working Approval Screen with Approve and Reject", async ({ page }) => {
  const accessToken = await loginAsDemoCustomer(page);
  await submitShoppingGoal(page, DEMO_LAPTOP_PHRASE, false);

  await expect(page.getByTestId("approval-required")).toHaveText("Approval required");
  await expect(page.getByText("REQUIRE_APPROVAL")).toBeVisible();
  await expect(page.getByTestId("top-pick-name")).toHaveText(/Nova Ultrabook/);
  await expect(page.getByRole("heading", { name: /Nova Ultrabook/i })).toBeVisible();
  await expect(page.getByText(/₹1,20,000/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^reject$/i })).toHaveCount(0);

  await page.getByRole("link", { name: /open approval screen/i }).click();
  await page.waitForURL(/\/approvals\/[0-9a-f-]+/i);

  await expect(page.getByRole("heading", { name: /Nova Ultrabook/i })).toBeVisible();
  await expect(page.getByText("Nova Electronics", { exact: true })).toBeVisible();
  await expect(page.getByText(/₹1,20,000/).first()).toBeVisible();
  await expect(page.getByText(/approval is required|daily spending limit|approval threshold/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^approve$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^reject$/i })).toBeVisible();

  await page.getByRole("button", { name: /^reject$/i }).click();
  await expect(page.getByTestId("approval-status")).toHaveText(/rejected/i);
  await expect(page.getByRole("button", { name: /^approve$/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^reject$/i })).toBeDisabled();

  const html = await page.content();
  expect(html).not.toContain(accessToken);
});

test("low-budget sports intent shows a clear NO_MATCHING_PRODUCTS message", async ({ page }) => {
  await loginAsDemoCustomer(page);
  await submitShoppingGoal(page, LOW_BUDGET_SPORTS_PHRASE, false);

  await expect(page.getByText(/couldn't find a product that matches/i)).toBeVisible();
  await expect(page.getByText("0 products found")).toBeVisible();
  await expect(page.locator("body")).not.toHaveText(/undefined|Cannot read|INTERNAL_ERROR/i);
});
