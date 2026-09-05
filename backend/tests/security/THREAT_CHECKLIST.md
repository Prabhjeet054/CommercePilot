# Phase 24 — PRD Sections 22–23 Threat → Test Checklist

Status after Phase 24 red-team pass. `security/*` = new consolidated adversarial coverage; other paths = pre-existing phase tests that still pass.

| Threat (PRD §22/§23) | Primary test(s) | Status |
|---|---|---|
| AuthN (bcrypt / JWT / refresh cookie) | `auth.integration.test.ts`, `auth.unit.test.ts` | PASS |
| AuthZ / RBAC (customer vs merchant_admin) | `auth.integration.test.ts`, `catalog.integration.test.ts` | PASS |
| IDOR — purchase intents / timeline / explain | `tests/security/idor-sweep.test.ts`, `orchestrator.api.test.ts`, `explain.api.test.ts`, `audit.timeline.test.ts` | PASS |
| IDOR — payments create-order / verify / retry | `tests/security/idor-sweep.test.ts`, `payments.create-order.test.ts`, `payments.verify.test.ts`, `payments.reconcile.test.ts` | PASS |
| IDOR — approvals | `approvals.api.test.ts` | PASS |
| Cross-merchant analytics / catalog | `tests/security/idor-sweep.test.ts`, `analytics.merchant.test.ts`, `catalog.integration.test.ts` | PASS |
| Input validation / enum allow-lists (role, purchaseMode) | `tests/security/enum-allowlist-validation.test.ts`, `intent-agent.test.ts`, `policy.api.test.ts`, `payments.schema` via amount-tampering | PASS |
| Rate limiting — `/auth/login` (Phase 3) | `tests/security/rate-limit.test.ts`, `auth.integration.test.ts` | PASS |
| Rate limiting — `/purchase-intents` & approval decisions | `tests/security/rate-limit.test.ts` (HTTP 429 on `/purchase-intents` + middleware unit + route mount) + `middleware/rateLimit.ts` (**added Phase 24**) | PASS |
| Secrets never in API / logs / FE bundle | `tests/security/secrets-sweep.test.ts`, `payments.secret-leak.test.ts`, `audit.secrets.test.ts`, `llm-provider.test.ts` | PASS |
| Signature verification (checkout + webhook) | `payments.verify.test.ts`, `webhooks.razorpay.test.ts`, `hmac.test.ts` | PASS |
| CORS allow-list | Covered by app CORS config; auth/integration against configured FRONTEND_URL | PASS (config) |
| CSRF (JWT-in-header for state changes) | Architectural — access JWT in Authorization header | PASS (design) |
| SQL injection prevention (Prisma) | Schema/service layer; no string-concat SQL in app modules | PASS (design + analytics raw SQL parameterized) |
| PII / no card data storage | Payments store ids/signatures only; no PAN fields in schema | PASS (schema) |
| Prompt injection via user text | `intent-agent.test.ts` | PASS |
| Prompt/tool injection via product description | `tests/security/prompt-injection-catalog.test.ts` | PASS |
| Unauthorized tool execution (LLM→payments/orders/approvals) | `tests/security/tool-injection-import-graph.test.ts`, `orchestrator.invariant.test.ts` | PASS |
| Agent goal manipulation / spending bypass via free text | `tests/security/policy-bypass-llm-claim.test.ts`, `policy.evaluate.test.ts` | PASS |
| Approval replay (same approval) | `approvals.api.test.ts` | PASS |
| Approval replay across intents | `tests/security/approval-cross-intent-replay.test.ts` | PASS |
| Amount tampering | `tests/security/amount-tampering.test.ts` | PASS |
| Fake payment confirmation (client provisional) | `payments.verify.test.ts`, `webhooks.razorpay.test.ts`, `payments.reconcile.test.ts` | PASS |
| Webhook spoofing | `webhooks.razorpay.test.ts` | PASS |
| LLM hallucinated product / ungrounded explain | `explain.api.test.ts`, `ranking.test.ts` | PASS |

## Fixes applied in Phase 24

1. **Missing write rate limits** — PRD §22 required per-user limits on `/purchase-intents` and `/approvals/:id/decision`; only `/auth/login` was limited. Added `middleware/rateLimit.ts` and mounted limiters on those routes.
2. **Eager Razorpay client masked authz** — `createRazorpayOrderForPurchaseIntent` / `createRazorpayOrder` evaluated `getRazorpayClient()` via default args before ownership/payable checks, so missing test/config clients returned `RAZORPAY_ERROR` instead of `NOT_PAYABLE`/`NOT_FOUND`. Client is now resolved only after those gates.

## Phase 24 validation follow-ups

3. **Enum allow-list coverage gap** — invalid `role` / `purchaseMode` at the API edge lacked isolated adversarial tests (only mixed malformed-body / missing-field cases). Added `enum-allowlist-validation.test.ts`.
4. **Weak rate-limit claim** — purchase-intent limiter was only asserted via source string + isolated middleware unit test. Added live `POST /purchase-intents` → 429 coverage.
5. **Secrets dist grep incomplete** — expanded `secrets-sweep` decoy list to include `JWT_SECRET`, `JWT_REFRESH_SECRET`, and `DATABASE_URL` name literals in production assets.
