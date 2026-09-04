import { describe, expect, it } from "vitest";
import {
  assertAuditPayloadSafe,
  AuditSecretLeakError,
  scrubAuditPayload,
} from "../src/modules/audit/audit.service";

describe("audit payload secret scrub", () => {
  it("allows ordinary commerce payloads", () => {
    expect(() =>
      scrubAuditPayload({
        decision: "ALLOW",
        reasonCode: "WITHIN_POLICY",
        razorpayOrderId: "order_dev_abc",
        amount: 4499,
      }),
    ).not.toThrow();
  });

  it("rejects payloads that embed secret env names", () => {
    expect(() =>
      assertAuditPayloadSafe({ note: "RAZORPAY_KEY_SECRET must never appear" }),
    ).toThrow(AuditSecretLeakError);
    expect(() =>
      assertAuditPayloadSafe({ hint: "RAZORPAY_WEBHOOK_SECRET=replace-me" }),
    ).toThrow(AuditSecretLeakError);
  });

  it("rejects secret-shaped keys and JWT-like values", () => {
    expect(() => assertAuditPayloadSafe({ key_secret: "x" })).toThrow(AuditSecretLeakError);
    expect(() => assertAuditPayloadSafe({ passwordHash: "x" })).toThrow(AuditSecretLeakError);
    expect(() =>
      assertAuditPayloadSafe({
        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.signature",
      }),
    ).toThrow(AuditSecretLeakError);
  });
});
