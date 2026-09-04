import { expect, type Page } from "@playwright/test";

export const DEMO_CUSTOMER = {
  email: "priya@commercepilot.demo",
  password: "password12",
};

export async function loginAsDemoCustomer(page: Page): Promise<string> {
  const loginResponse = page.waitForResponse(
    (response) => response.url().includes("/auth/login") && response.request().method() === "POST",
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill(DEMO_CUSTOMER.email);
  await page.getByLabel("Password").fill(DEMO_CUSTOMER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const response = await loginResponse;
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { accessToken: string };
  await page.waitForURL(/\/shop/);
  return body.accessToken;
}

export async function submitShoppingGoal(page: Page, text: string, autonomous: boolean): Promise<string> {
  await page.getByLabel("Shopping goal").fill(text);
  const checkbox = page.getByRole("checkbox", { name: /buy the best option automatically/i });
  if ((await checkbox.isChecked()) !== autonomous) {
    await checkbox.click();
  }
  const created = page.waitForResponse(
    (response) =>
      response.url().includes("/purchase-intents") &&
      response.request().method() === "POST" &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Ask CommercePilot" }).click();
  const response = await created;
  const body = (await response.json()) as { id: string };
  await page.waitForURL(new RegExp(`/shop/${body.id}`));
  return body.id;
}
