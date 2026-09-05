# Security

## Posture (PRD §22)

| Control | Implementation |
|---|---|
| AuthN | bcrypt (≥12), short-lived JWT access + httpOnly refresh cookie |
| AuthZ / RBAC | `customer` \| `merchant_admin`; route `requireRole` + ownership loaders |
| Input validation | zod on request bodies; strict enums for `role`, `purchaseMode`, categories |
| Rate limiting | Login (IP); purchase-intent writes + approval decisions (per user) |
| Secrets | Key Secret / webhook secret / JWTs / `DATABASE_URL` only in backend env — never frontend |
| Signatures | Checkout HMAC + webhook HMAC (raw body) — never trust client alone |
| CORS | Allow-list = `FRONTEND_URL` |
| CSRF | State-changing calls use Authorization header JWT (refresh cookie is SameSite) |
| Injection | Prisma parameterized queries; no string-concat SQL for app logic |
| PII | Name/email/contact for checkout prefill only; no card PAN storage |

## AI threats (PRD §23)

| Threat | Mitigation | Primary tests |
|---|---|---|
| Prompt injection (user text) | Schema-validated intent; reject non-enum fields | `intent-agent.test.ts` |
| Malicious product descriptions | Ranking treats catalog text as data; scores ignore instructional prose | `tests/security/prompt-injection-catalog.test.ts` |
| Agent goal manipulation | LLM has no payment path; policy reads DB fields only | `tests/security/policy-bypass-llm-claim.test.ts` |
| Unauthorized tool execution | Import-graph forbid LLM→payments/orders/approvals | `tests/security/tool-injection-import-graph.test.ts` |
| Spending limit bypass | Deterministic policy engine | `policy.evaluate.test.ts` |
| Approval replay | Atomic consume + TTL; intent binding | `approvals.api.test.ts`, `approval-cross-intent-replay.test.ts` |
| Fake payment confirmation | Verify provisional; webhook/reconcile authoritative | `payments.verify.test.ts`, `webhooks.razorpay.test.ts` |
| Webhook spoofing | HMAC reject before state touch | `webhooks.razorpay.test.ts` |
| Hallucinated product info | Explain grounded in stored factors | `explain.api.test.ts` |

Full Phase 24 checklist: `backend/tests/security/THREAT_CHECKLIST.md`.

## Secret-leak verification

```bash
cd frontend && npm run build
# Grep dist for RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, JWT_SECRET,
# JWT_REFRESH_SECRET, DATABASE_URL — automated in:
cd backend && npm test -- tests/security/secrets-sweep.test.ts tests/payments.secret-leak.test.ts
```

## Dependency notes (Phase 25 audit)

`npm audit` on `backend/` (2026-09-05): **8** advisories (1 critical, 4 high, 3 moderate) — mostly transitive via `tar`/`@mapbox/node-pre-gyp` (bcrypt native tooling), `prisma`/`deepmerge-ts`, and `qs`/`body-parser`/`express`. Not all are safely force-fixable without major upgrades under demo time pressure. Before any public deploy:

1. Re-run `cd backend && npm audit` and `cd frontend && npm audit`.
2. Prefer targeted upgrades (`prisma`, `express`) over `npm audit fix --force`.
3. Keep Razorpay credentials in Test Mode only for this repository.

| Area | Note |
|---|---|
| `openai@7` | Declares Node ≥22; Docker uses Node 20 — works with warning; upgrade image to Node 22 when convenient |
| `razorpay` SDK | Pin to Test Mode keys only; never ship live-mode secrets |
| Frontend Vite 6 | Only `VITE_API_URL` is public; no secret `VITE_*` vars |

## Design statement

The AI is never the sole source of authorization for any financial action. It is a proposer, not an approver.
