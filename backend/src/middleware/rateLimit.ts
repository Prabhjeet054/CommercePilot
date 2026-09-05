import rateLimit from "express-rate-limit";
import type { Request } from "express";

/**
 * Phase 24 / PRD Section 22 — per-user token bucket for abuse-sensitive writes.
 * Keyed by authenticated user id when present; falls back to IP.
 */
export function createUserRateLimiter(options: {
  windowMs: number;
  max: number;
  message?: { error: string };
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: options.message ?? { error: "TOO_MANY_REQUESTS" },
    validate: { xForwardedForHeader: false },
    keyGenerator: (req: Request) => {
      if (req.user?.id) {
        return `user:${req.user.id}`;
      }
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string" && forwarded.length > 0) {
        return `ip:${forwarded.split(",")[0]?.trim() ?? req.ip ?? "local"}`;
      }
      return `ip:${req.ip ?? "local"}`;
    },
  });
}

export function purchaseIntentWriteLimiter() {
  const raw = Number(process.env.PURCHASE_INTENT_RATE_LIMIT_MAX ?? "30");
  return createUserRateLimiter({
    windowMs: 60_000,
    max: Number.isFinite(raw) && raw > 0 ? raw : 30,
  });
}

export function approvalDecisionLimiter() {
  const raw = Number(process.env.APPROVAL_DECISION_RATE_LIMIT_MAX ?? "30");
  return createUserRateLimiter({
    windowMs: 60_000,
    max: Number.isFinite(raw) && raw > 0 ? raw : 30,
  });
}
