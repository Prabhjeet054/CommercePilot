import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/**
 * Phase 20 audit writes are **best-effort**: a failed insert is logged loudly and
 * never thrown to the caller. Trade-off: a payment/policy transition can succeed
 * without a durable audit row (acceptable for hackathon; production would want
 * outbox / retry). Blocking the money path on audit I/O is worse here.
 */

export const AUDIT_ACTIONS = [
  "intent_received",
  "intent_extracted",
  "products_searched",
  "products_ranked",
  "recommendation_created",
  "policy_evaluated",
  "approval_requested",
  "approval_granted",
  "approval_rejected",
  "order_created",
  "payment_initiated",
  "payment_verified",
  "webhook_received",
  "order_completed",
  "payment_failed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type RecordAuditInput = {
  purchaseIntentId: string | null;
  actor: string;
  action: AuditAction | string;
  payload?: unknown;
  correlationId: string;
};

const SECRET_NEEDLES = [
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "DATABASE_URL",
  "passwordHash",
  "password_hash",
  "key_secret",
  "webhook_secret",
];

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-(?:live|test|proj)-[A-Za-z0-9_-]{8,}\b/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, // JWT-shaped
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/, // bcrypt
];

export class AuditSecretLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditSecretLeakError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Deep-scan payload for secret names / shapes before persistence. */
export function assertAuditPayloadSafe(payload: unknown, path = "payload"): void {
  if (payload === null || payload === undefined) {
    return;
  }
  if (typeof payload === "string") {
    const text = payload;
    for (const needle of SECRET_NEEDLES) {
      if (text.includes(needle)) {
        throw new AuditSecretLeakError(`Forbidden secret marker "${needle}" in ${path}`);
      }
    }
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(text)) {
        throw new AuditSecretLeakError(`Forbidden secret-shaped value in ${path}`);
      }
    }
    return;
  }
  if (typeof payload === "number" || typeof payload === "boolean") {
    return;
  }
  if (Array.isArray(payload)) {
    payload.forEach((item, index) => assertAuditPayloadSafe(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("secret") ||
        lower.includes("password") ||
        lower === "authorization" ||
        lower === "cookie"
      ) {
        throw new AuditSecretLeakError(`Forbidden payload key "${key}" at ${path}`);
      }
      assertAuditPayloadSafe(value, `${path}.${key}`);
    }
  }
}

/** Redact unsafe keys if present; still throws on secret-shaped string values. */
export function scrubAuditPayload(payload: unknown): Prisma.InputJsonValue | undefined {
  if (payload === undefined) {
    return undefined;
  }
  assertAuditPayloadSafe(payload);
  return payload as Prisma.InputJsonValue;
}

export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Resolve the intent's correlation id from the first audit row, else fall back
 * to the purchaseIntentId (stable thread for late webhooks/payments).
 */
export async function resolveCorrelationId(purchaseIntentId: string): Promise<string> {
  const first = await prisma.auditLog.findFirst({
    where: { purchaseIntentId },
    orderBy: { createdAt: "asc" },
    select: { correlationId: true },
  });
  if (first?.correlationId && first.correlationId.trim().length > 0) {
    return first.correlationId;
  }
  return purchaseIntentId;
}

export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    const payload = scrubAuditPayload(input.payload);
    await prisma.auditLog.create({
      data: {
        purchaseIntentId: input.purchaseIntentId,
        actor: input.actor,
        action: input.action,
        payload: payload === undefined ? Prisma.JsonNull : payload,
        correlationId: input.correlationId,
      },
    });
  } catch (err) {
    if (err instanceof AuditSecretLeakError) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "audit_secret_leak_blocked",
          action: input.action,
          purchaseIntentId: input.purchaseIntentId,
          message: err.message,
        }),
      );
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        level: "error",
        event: "audit_write_failed",
        action: input.action,
        purchaseIntentId: input.purchaseIntentId,
        correlationId: input.correlationId,
        message,
      }),
    );
  }
}

export type TimelineEventDto = {
  id: string;
  action: string;
  actor: string;
  payload: unknown;
  correlationId: string | null;
  createdAt: string;
};

export async function listTimelineForIntent(purchaseIntentId: string): Promise<TimelineEventDto[]> {
  const rows = await prisma.auditLog.findMany({
    where: { purchaseIntentId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actor: row.actor,
    payload: row.payload,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
  }));
}
