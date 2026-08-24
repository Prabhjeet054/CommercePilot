import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import {
  BCRYPT_COST,
  hashPassword,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from "../src/modules/auth/auth.service";

const ACCESS_SECRET = "unit-test-access-secret";
const user = { id: "11111111-1111-1111-1111-111111111111", role: "customer" };

describe("password hashing", () => {
  it("hashes with bcrypt cost 12 and verifies the original password", async () => {
    const password = "correct-horse-battery";
    const hash = await hashPassword(password);

    expect(hash).not.toBe(password);
    expect(hash.startsWith(`$2b$${BCRYPT_COST}$`) || hash.startsWith(`$2a$${BCRYPT_COST}$`)).toBe(
      true,
    );
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});

describe("JWT issuance and verification", () => {
  it("issues an access token containing only id (sub) and role", () => {
    const token = signAccessToken(user, ACCESS_SECRET);
    const payload = jwt.decode(token) as jwt.JwtPayload;

    expect(payload.sub).toBe(user.id);
    expect(payload.role).toBe("customer");
    expect(payload.typ).toBe("access");
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("password");
    expect(payload).not.toHaveProperty("passwordHash");
    expect(verifyAccessToken(token, ACCESS_SECRET)).toEqual({
      sub: user.id,
      role: "customer",
      typ: "access",
    });
  });

  it("rejects an expired access token", () => {
    const token = signAccessToken(user, ACCESS_SECRET, "-1s");
    expect(() => verifyAccessToken(token, ACCESS_SECRET)).toThrow();
  });

  it("rejects a tampered token that was not re-signed", () => {
    const token = signAccessToken(user, ACCESS_SECRET);
    const [header, payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    decoded.role = "merchant_admin";
    const tampered = `${header}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;

    expect(() => verifyAccessToken(tampered, ACCESS_SECRET)).toThrow();
  });

  it("rejects a refresh token used as an access token", () => {
    const refresh = jwt.sign(
      { sub: user.id, role: user.role, typ: "refresh", jti: "jti-1" },
      ACCESS_SECRET,
      { expiresIn: "7d" },
    );
    expect(() => verifyAccessToken(refresh, ACCESS_SECRET)).toThrow();
  });
});
