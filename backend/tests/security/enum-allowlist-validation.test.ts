import { randomUUID } from "crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

/**
 * Phase 24 validation — fresh adversarial scenarios not enumerated in the
 * Phase 24 implementation prompt: enum allow-list enforcement at the API edge
 * (PRD §22 input validation / strict allow-lists for role and purchase_mode).
 */

const JWT_SECRET = "security-enum-allowlist-access!";
const JWT_REFRESH_SECRET = "security-enum-allowlist-refresh";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

function clientIp() {
  return `203.0.113.${1 + Math.floor(Math.random() * 200)}`;
}

describe("security: enum allow-list validation (Phase 24 validation)", () => {
  afterEach(async () => {
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "sec-enum-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "sec-enum-" } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects register with a role outside customer|merchant_admin (otherwise-valid body)", async () => {
    const email = `sec-enum-role-${randomUUID()}@example.com`;
    const response = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({
        email,
        password: "password12",
        name: "Valid Name",
        role: "superadmin",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(response.body.fields?.role).toMatch(/customer|merchant_admin/i);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("rejects purchase intents with purchaseMode outside autonomous|manual (no silent coercion)", async () => {
    const email = `sec-enum-pm-${randomUUID()}@example.com`;
    const registered = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({ email, password: "password12", name: "PM User", role: "customer" });
    expect(registered.status).toBe(201);
    const token = registered.body.accessToken as string;

    const invalidModes = ["semi_autonomous", "AUTONOMOUS", "Manual", "bypass", ""];
    for (const purchaseMode of invalidModes) {
      const response = await request(app)
        .post("/purchase-intents")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Forwarded-For", clientIp())
        .send({ text: "buy running shoes under 5000", purchaseMode });

      expect(response.status, `mode=${JSON.stringify(purchaseMode)}`).toBe(400);
      expect(response.body.error).toBe("VALIDATION_ERROR");
      expect(response.body.fields?.purchaseMode).toMatch(/autonomous|manual/i);
    }

    expect(
      await prisma.purchaseIntent.count({
        where: { user: { email } },
      }),
    ).toBe(0);
  });
});
