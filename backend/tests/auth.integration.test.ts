import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { INVALID_CREDENTIALS, signAccessToken } from "../src/modules/auth/auth.service";

const JWT_SECRET = "integration-access-secret";
const JWT_REFRESH_SECRET = "integration-refresh-secret";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  NODE_ENV: "test",
});

function uniqueEmail(prefix = "auth-test"): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

function clientIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "auth-test-" } } });
  await prisma.$disconnect();
});

describe("auth integration", () => {
  it("registers and logs in a customer, then hits a protected route", async () => {
    const email = uniqueEmail();
    const ip = clientIp();
    const password = "password12";

    const registered = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", ip)
      .send({ email, password, name: "Priya", role: "customer" });

    expect(registered.status).toBe(201);
    expect(registered.body.user).toMatchObject({ email, role: "customer", name: "Priya" });
    expect(registered.body.accessToken).toEqual(expect.any(String));
    expect(JSON.stringify(registered.body)).not.toMatch(/password/i);
    expect(registered.headers["set-cookie"]?.join(";")).toContain("refreshToken=");

    const me = await request(app)
      .get("/auth/me")
      .set(authHeader(registered.body.accessToken as string));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);

    const login = await request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", clientIp())
      .send({ email, password });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("customer");
  });

  it("registers and logs in a merchant_admin and allows the admin route", async () => {
    const email = uniqueEmail();
    const password = "password12";

    const registered = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({ email, password, name: "Arjun", role: "merchant_admin" });
    expect(registered.status).toBe(201);

    const login = await request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", clientIp())
      .send({ email, password });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("merchant_admin");
    expect(JSON.stringify(login.body)).not.toMatch(/password/i);

    const admin = await request(app)
      .get("/auth/admin-check")
      .set(authHeader(login.body.accessToken as string));
    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({ ok: true });
  });

  it("returns 409 EMAIL_ALREADY_EXISTS for a duplicate email", async () => {
    const email = uniqueEmail();
    const payload = { email, password: "password12", name: "Dup", role: "customer" };

    await request(app).post("/auth/register").set("X-Forwarded-For", clientIp()).send(payload);
    const duplicate = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send(payload);

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({ error: "EMAIL_ALREADY_EXISTS" });
  });

  it("treats emails that differ only by case as the same account", async () => {
    const local = `auth-test-${randomUUID()}`;
    const password = "password12";

    const registered = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({
        email: `${local}@Example.COM`,
        password,
        name: "Case",
        role: "customer",
      });
    expect(registered.status).toBe(201);
    expect(registered.body.user.email).toBe(`${local}@example.com`);

    const login = await request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", clientIp())
      .send({ email: `${local.toUpperCase()}@example.com`, password });
    expect(login.status).toBe(200);
  });

  it("returns the same 401 shape for unknown email and wrong password", async () => {
    const email = uniqueEmail();
    await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({ email, password: "password12", name: "Enum", role: "customer" });

    const unknown = await request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", clientIp())
      .send({ email: uniqueEmail(), password: "password12" });
    const wrong = await request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", clientIp())
      .send({ email, password: "wrongpass" });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual({ error: INVALID_CREDENTIALS });
    expect(wrong.body).toEqual(unknown.body);
  });

  it("rejects missing, expired, and wrong-role tokens on protected routes", async () => {
    const customer = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({
        email: uniqueEmail(),
        password: "password12",
        name: "Cust",
        role: "customer",
      });

    const missing = await request(app).get("/auth/me");
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: "UNAUTHORIZED" });

    const expired = signAccessToken(
      { id: customer.body.user.id as string, role: "customer" },
      JWT_SECRET,
      "-1s",
    );
    const expiredRes = await request(app).get("/auth/me").set(authHeader(expired));
    expect(expiredRes.status).toBe(401);

    const wrongRole = await request(app)
      .get("/auth/admin-check")
      .set(authHeader(customer.body.accessToken as string));
    expect(wrongRole.status).toBe(403);
    expect(wrongRole.body).toEqual({ error: "FORBIDDEN" });
  });

  it("returns 404 not 403 when requireOwnership sees another user's resource", async () => {
    const owner = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({
        email: uniqueEmail(),
        password: "password12",
        name: "Owner",
        role: "customer",
      });
    const stranger = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({
        email: uniqueEmail(),
        password: "password12",
        name: "Stranger",
        role: "customer",
      });

    const own = await request(app)
      .get(`/auth/ownership-check/${owner.body.user.id}`)
      .set(authHeader(owner.body.accessToken as string));
    expect(own.status).toBe(200);

    const leaked = await request(app)
      .get(`/auth/ownership-check/${owner.body.user.id}`)
      .set(authHeader(stranger.body.accessToken as string));
    expect(leaked.status).toBe(404);
    expect(leaked.body).toEqual({ error: "NOT_FOUND" });
    expect(leaked.status).not.toBe(403);
  });

  it("returns 400 with field-level errors for a malformed body", async () => {
    const response = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({ email: "not-an-email", password: "short", name: "", role: "admin" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(response.body.fields).toEqual(
      expect.objectContaining({
        email: expect.any(String),
        password: expect.any(String),
        name: expect.any(String),
        role: expect.any(String),
      }),
    );
  });

  it("clears the refresh cookie on logout so reuse fails", async () => {
    const registered = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({
        email: uniqueEmail(),
        password: "password12",
        name: "Logout",
        role: "customer",
      });

    const cookies = registered.headers["set-cookie"];
    expect(cookies).toBeDefined();

    const logout = await request(app)
      .post("/auth/logout")
      .set(authHeader(registered.body.accessToken as string))
      .set("Cookie", cookies!);
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ success: true });

    const reused = await request(app).post("/auth/refresh").set("Cookie", cookies!);
    expect(reused.status).toBe(401);
  });

  it("issues a new access token from a valid refresh cookie", async () => {
    const registered = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({
        email: uniqueEmail(),
        password: "password12",
        name: "Refresh",
        role: "customer",
      });

    const refreshed = await request(app)
      .post("/auth/refresh")
      .set("Cookie", registered.headers["set-cookie"]!);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toEqual(expect.any(String));

    const me = await request(app)
      .get("/auth/me")
      .set(authHeader(refreshed.body.accessToken as string));
    expect(me.status).toBe(200);
  });

  it("rate-limits /auth/login after 10 requests from the same IP", async () => {
    const ip = "198.51.100.9";
    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
      const response = await request(app)
        .post("/auth/login")
        .set("X-Forwarded-For", ip)
        .send({ email: "rate-limit@example.com", password: "password12" });
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("does not put email or password material in the access token", async () => {
    const email = uniqueEmail();
    const registered = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({ email, password: "password12", name: "Token", role: "customer" });

    const payload = jwt.decode(registered.body.accessToken as string) as jwt.JwtPayload;
    expect(payload.sub).toBe(registered.body.user.id);
    expect(payload.role).toBe("customer");
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "role", "sub", "typ"].sort());
    expect(JSON.stringify(payload)).not.toContain(email);
    expect(JSON.stringify(payload)).not.toMatch(/password/i);
  });

  it("rejects a tampered access token at requireAuth", async () => {
    const registered = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({
        email: uniqueEmail(),
        password: "password12",
        name: "Tamper",
        role: "customer",
      });

    const token = registered.body.accessToken as string;
    const [header, payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      role: string;
    };
    decoded.role = "merchant_admin";
    const tampered = `${header}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;

    const me = await request(app).get("/auth/me").set(authHeader(tampered));
    expect(me.status).toBe(401);
    expect(me.body).toEqual({ error: "UNAUTHORIZED" });
  });

  it("never echoes plaintext passwords or hashes in bodies or logs", async () => {
    const logs: string[] = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "info").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);

    const secretPassword = "plaintext-secret-99";
    const registered = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", clientIp())
      .send({
        email: uniqueEmail(),
        password: secretPassword,
        name: "NoLeak",
        role: "customer",
      });

    expect(registered.status).toBe(201);
    const bodies = [
      JSON.stringify(registered.body),
      JSON.stringify(
        (
          await request(app)
            .get("/auth/me")
            .set(authHeader(registered.body.accessToken as string))
        ).body,
      ),
    ];

    for (const body of bodies) {
      expect(body).not.toContain(secretPassword);
      expect(body).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
    }
    expect(logs.join("\n")).not.toContain(secretPassword);
    expect(logs.join("\n")).not.toMatch(/\$2[aby]\$/);
  });
});
