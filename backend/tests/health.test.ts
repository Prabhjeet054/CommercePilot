import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";

const TEST_JWT = "health-test-access-secret";
const TEST_REFRESH = "health-test-refresh-secret";

const app = createApp({
  FRONTEND_URL: "http://localhost:5173",
  JWT_SECRET: TEST_JWT,
  JWT_REFRESH_SECRET: TEST_REFRESH,
  NODE_ENV: "test",
});

describe("GET /health", () => {
  it("returns 200 with status ok and an ISO timestamp", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      timestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
  });

  it("allows CORS from FRONTEND_URL and rejects other origins", async () => {
    const allowed = await request(app)
      .get("/health")
      .set("Origin", "http://localhost:5173");
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );

    const allowedLoopback = await request(app)
      .get("/health")
      .set("Origin", "http://127.0.0.1:5173");
    expect(allowedLoopback.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");

    const blocked = await request(app)
      .get("/health")
      .set("Origin", "http://evil.example");
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();

    const blockedPort = await request(app)
      .get("/health")
      .set("Origin", "http://127.0.0.1:9999");
    expect(blockedPort.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
