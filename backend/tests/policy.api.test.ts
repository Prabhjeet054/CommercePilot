import { randomUUID } from "crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { REASON } from "../src/modules/policy/evaluate";

const JWT_SECRET = "policy-api-access-secret";
const JWT_REFRESH_SECRET = "policy-api-refresh-secret";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

const DEMO_POLICY = {
  maxAutonomousAmount: 5000,
  dailySpendingLimit: 10000,
  approvalThreshold: 5000,
  allowedCategories: ["Electronics", "Sports", "Travel"],
  blockedCategories: [] as string[],
  trustedMerchants: [] as string[],
  autonomousEnabled: true,
  maxAutonomousTxnsPerDay: 3,
};

function uniqueEmail(prefix = "policy-api-test"): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

function clientIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function registerUser(role: "customer" | "merchant_admin") {
  const email = uniqueEmail();
  const response = await request(app)
    .post("/auth/register")
    .set("X-Forwarded-For", clientIp())
    .send({ email, password: "password12", name: "Policy Api User", role });
  expect(response.status).toBe(201);
  return {
    token: response.body.accessToken as string,
    user: response.body.user as { id: string; role: string },
  };
}

describe("policy API", () => {
  afterAll(async () => {
    await prisma.financialPolicy.deleteMany({
      where: { user: { email: { startsWith: "policy-api-test-" } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: "policy-api-test-" } } });
    await prisma.$disconnect();
  });

  it("returns 404 NO_POLICY_CONFIGURED with a setup message when none exists", async () => {
    const customer = await registerUser("customer");
    const response = await request(app).get("/policies/me").set(authHeader(customer.token));

    expect(response.status).toBe(404);
    expect(response.body.error).toBe(REASON.NO_POLICY_CONFIGURED);
    expect(response.body.message).toMatch(/set up your policy/i);
  });

  it("creates the PRD Section 32 demo policy and fetches it back", async () => {
    const customer = await registerUser("customer");
    const created = await request(app)
      .post("/policies")
      .set(authHeader(customer.token))
      .send(DEMO_POLICY);

    expect(created.status).toBe(201);
    expect(created.body.userId).toBe(customer.user.id);
    expect(created.body.maxAutonomousAmount).toBe("5000.00");
    expect(created.body.dailySpendingLimit).toBe("10000.00");
    expect(created.body.approvalThreshold).toBe("5000.00");
    expect(created.body.allowedCategories).toEqual(["Electronics", "Sports", "Travel"]);
    expect(created.body.autonomousEnabled).toBe(true);
    expect(created.body.maxAutonomousTxnsPerDay).toBe(3);

    const fetched = await request(app).get("/policies/me").set(authHeader(customer.token));
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(created.body.id);
    expect(fetched.body.maxAutonomousAmount).toBe("5000.00");
  });

  it("upserts on re-save instead of creating a second row", async () => {
    const customer = await registerUser("customer");
    const first = await request(app)
      .post("/policies")
      .set(authHeader(customer.token))
      .send(DEMO_POLICY);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/policies")
      .set(authHeader(customer.token))
      .send({ ...DEMO_POLICY, dailySpendingLimit: 12000 });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.dailySpendingLimit).toBe("12000.00");

    const count = await prisma.financialPolicy.count({ where: { userId: customer.user.id } });
    expect(count).toBe(1);
  });

  it("ignores a foreign userId in the body and binds the policy to the JWT subject", async () => {
    const owner = await registerUser("customer");
    const stranger = await registerUser("customer");

    const created = await request(app)
      .post("/policies")
      .set(authHeader(owner.token))
      .send({ ...DEMO_POLICY, userId: stranger.user.id });

    expect(created.status).toBe(201);
    expect(created.body.userId).toBe(owner.user.id);
    expect(created.body.userId).not.toBe(stranger.user.id);

    const strangerGet = await request(app).get("/policies/me").set(authHeader(stranger.token));
    expect(strangerGet.status).toBe(404);

    const ownerGet = await request(app).get("/policies/me").set(authHeader(owner.token));
    expect(ownerGet.status).toBe(200);
    expect(ownerGet.body.userId).toBe(owner.user.id);
  });

  it("rejects merchant_admin writes with 403 and unauthenticated calls with 401", async () => {
    const admin = await registerUser("merchant_admin");
    const denied = await request(app).post("/policies").set(authHeader(admin.token)).send(DEMO_POLICY);
    expect(denied.status).toBe(403);

    const unauth = await request(app).get("/policies/me");
    expect(unauth.status).toBe(401);
  });

  it("rejects negative monetary fields with 400 and does not require relative ordering", async () => {
    const customer = await registerUser("customer");
    const negative = await request(app)
      .post("/policies")
      .set(authHeader(customer.token))
      .send({ ...DEMO_POLICY, approvalThreshold: -1 });
    expect(negative.status).toBe(400);

    const inverted = await request(app)
      .post("/policies")
      .set(authHeader(customer.token))
      .send({
        ...DEMO_POLICY,
        approvalThreshold: 1000,
        maxAutonomousAmount: 9000,
        dailySpendingLimit: 500,
      });
    expect(inverted.status).toBe(201);
    expect(inverted.body.approvalThreshold).toBe("1000.00");
    expect(inverted.body.maxAutonomousAmount).toBe("9000.00");
    expect(inverted.body.dailySpendingLimit).toBe("500.00");
  });
});
