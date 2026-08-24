import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "../src/config/env";

describe("loadEnv", () => {
  it("throws a named EnvValidationError when DATABASE_URL is missing", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "test",
        PORT: "3000",
        FRONTEND_URL: "http://localhost:5173",
      }),
    ).toThrow(EnvValidationError);

    try {
      loadEnv({
        NODE_ENV: "test",
        PORT: "3000",
        FRONTEND_URL: "http://localhost:5173",
      });
      throw new Error("expected loadEnv to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).name).toBe("EnvValidationError");
      expect((err as Error).message).toContain("DATABASE_URL is required");
    }
  });

  it("throws a named EnvValidationError when FRONTEND_URL is missing", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "test",
        PORT: "3000",
        DATABASE_URL: "postgresql://commercepilot:commercepilot@localhost:5432/commercepilot",
      }),
    ).toThrow(EnvValidationError);
  });

  it("returns parsed env when required vars are present", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      PORT: "3000",
      DATABASE_URL: "postgresql://commercepilot:commercepilot@localhost:5432/commercepilot",
      FRONTEND_URL: "http://localhost:5173",
      JWT_SECRET: "phase3-dev-access-secret-change-me",
      JWT_REFRESH_SECRET: "phase3-dev-refresh-secret-change-me",
    });

    expect(env.PORT).toBe(3000);
    expect(env.FRONTEND_URL).toBe("http://localhost:5173");
    expect(env.DATABASE_URL).toContain("postgresql://");
    expect(env.JWT_SECRET).toHaveLength(env.JWT_SECRET.length);
  });
});
