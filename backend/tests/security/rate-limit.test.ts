import express from "express";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { createUserRateLimiter } from "../../src/middleware/rateLimit";
import { prisma } from "../../src/lib/prisma";

/**
 * PRD §22 — Rate limiting verification (Phase 3 auth + Phase 24 purchase/approval limiters).
 */

const JWT_SECRET = "security-ratelimit-access!!";
const JWT_REFRESH_SECRET = "security-ratelimit-refresh!";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

function clientIp(suffix: number) {
  return `198.51.100.${suffix}`;
}

describe("security: rate limiting", () => {
  afterEach(async () => {
    await prisma.purchaseIntent.deleteMany({
      where: { user: { email: { startsWith: "sec-rl-write-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "sec-rl-write-" } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("Phase 3: /auth/login still returns 429 after 10 attempts from the same IP", async () => {
    const ip = clientIp(40 + Math.floor(Math.random() * 50));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const response = await request(app)
        .post("/auth/login")
        .set("X-Forwarded-For", ip)
        .send({ email: "rate-limit-missing@example.com", password: "password12" });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("POST /purchase-intents returns 429 after per-user max (not just source-mounted)", async () => {
    const previous = process.env.PURCHASE_INTENT_RATE_LIMIT_MAX;
    process.env.PURCHASE_INTENT_RATE_LIMIT_MAX = "2";
    try {
      const limitedApp = createApp({
        FRONTEND_URL: "http://localhost:5173",
        JWT_SECRET,
        JWT_REFRESH_SECRET,
        NODE_ENV: "test",
      });

      const email = `sec-rl-write-${randomUUID()}@example.com`;
      const registered = await request(limitedApp)
        .post("/auth/register")
        .set("X-Forwarded-For", clientIp(12))
        .send({ email, password: "password12", name: "Rate User", role: "customer" });
      expect(registered.status).toBe(201);
      const token = registered.body.accessToken as string;

      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const response = await request(limitedApp)
          .post("/purchase-intents")
          .set("Authorization", `Bearer ${token}`)
          .set("X-Forwarded-For", clientIp(90 + i))
          .send({ text: "buy anything", purchaseMode: "manual" });
        statuses.push(response.status);
      }
      expect(statuses[0]).not.toBe(429);
      expect(statuses[1]).not.toBe(429);
      expect(statuses[2]).toBe(429);
    } finally {
      if (previous === undefined) {
        delete process.env.PURCHASE_INTENT_RATE_LIMIT_MAX;
      } else {
        process.env.PURCHASE_INTENT_RATE_LIMIT_MAX = previous;
      }
    }
  });

  it("per-user write limiter returns 429 after the configured max (purchase/approval pattern)", async () => {
    const mini = express();
    mini.set("trust proxy", 1);
    mini.use(express.json());
    mini.use((req, _res, next) => {
      req.user = { id: "rate-limit-user-1", role: "customer", email: "rl@example.com" };
      next();
    });
    mini.post(
      "/limited",
      createUserRateLimiter({ windowMs: 60_000, max: 3 }),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await request(mini).post("/limited").send({});
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses[3]).toBe(429);
  });

  it("orchestrator and approval routers mount the Phase 24 write limiters", () => {
    const orchestrator = readFileSync(
      path.resolve(__dirname, "../../src/modules/orchestrator/orchestrator.routes.ts"),
      "utf8",
    );
    const approvals = readFileSync(
      path.resolve(__dirname, "../../src/modules/approvals/approval.routes.ts"),
      "utf8",
    );
    expect(orchestrator).toContain("purchaseIntentWriteLimiter");
    expect(approvals).toContain("approvalDecisionLimiter");
  });
});
