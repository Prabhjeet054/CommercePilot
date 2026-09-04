import { createHmac } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  razorpayCheckoutSignedPayload,
  signRazorpayCheckoutPayload,
  verifySignature,
} from "../src/lib/hmac";

describe("hmac.verifySignature", () => {
  const secret = "phase17-hmac-unit-secret";
  const payload = razorpayCheckoutSignedPayload("order_abc", "pay_xyz");
  const genuine = signRazorpayCheckoutPayload("order_abc", "pay_xyz", secret);

  it("accepts a genuine HMAC-SHA256 hex digest", () => {
    expect(verifySignature(payload, genuine, secret)).toBe(true);
    expect(genuine).toBe(createHmac("sha256", secret).update(payload).digest("hex"));
  });

  it("rejects a same-length single-character flip (not a length-only check)", () => {
    const flipped = `${genuine.slice(0, -1)}${genuine.endsWith("0") ? "1" : "0"}`;
    expect(flipped.length).toBe(genuine.length);
    expect(flipped).not.toBe(genuine);
    expect(verifySignature(payload, flipped, secret)).toBe(false);
  });

  it("rejects truncated and elongated signatures without throwing", () => {
    expect(verifySignature(payload, genuine.slice(0, 16), secret)).toBe(false);
    expect(verifySignature(payload, `${genuine}ab`, secret)).toBe(false);
  });

  it("source uses crypto.timingSafeEqual (not ===) for the digest compare", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/lib/hmac.ts"), "utf8");
    expect(source).toMatch(/timingSafeEqual\s*\(/);
    expect(source).not.toMatch(/expected\s*===\s*signature|signature\s*===\s*expected/);
    // Digest compare must not use loose equality on the hex strings.
    const compareRegion = source.slice(source.indexOf("expectedBuf"), source.lastIndexOf("}"));
    expect(compareRegion).toContain("timingSafeEqual");
    expect(compareRegion).not.toMatch(/expectedBuf\s*===\s*actualBuf|actualBuf\s*===\s*expectedBuf/);
  });
});
