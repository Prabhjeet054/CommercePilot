# Testing

## Commands

```bash
# Backend unit + integration + security (Vitest / Postgres)
cd backend && npm test

# Policy engine + state machine coverage gates (100% on included files)
cd backend && npm run test:coverage

# Frontend unit
cd frontend && npm test

# Playwright E2E (API + UI; requires running stack + seeded demo)
cd frontend && npm run test:e2e
```

Root shortcuts: `npm test`, `npm run test:coverage`.

## Layers

| Layer | Location | What it covers |
|---|---|---|
| Unit | `backend/tests/policy.evaluate.test.ts`, `state-machine.test.ts`, `ranking.test.ts`, `hmac.test.ts`, … | Deterministic cores without network |
| Integration / API | `*.api.test.ts`, `*.integration.test.ts`, payments/webhooks/approvals | HTTP + Postgres + injected Razorpay/LLM doubles |
| Security / red team | `backend/tests/security/*` | PRD §22–23 adversarial cases |
| Demo reset meta | `backend/tests/demo-reset.meta.test.ts` | `demo:reset` ≡ fresh seed |
| Invariants | `orchestrator.invariant.test.ts`, `state-machine.invariant.test.ts`, import-graph | Architectural forbidden imports / writers |
| Frontend E2E | `frontend/e2e/*` | Shop → checkout (Checkout double when keys are placeholders), purchase/approval flows |

## Coverage figures (gated)

`vitest` coverage include (see `backend/vitest.config.ts`):

| Module | Gate |
|---|---|
| `src/modules/policy/evaluate.ts` | 100% statements / branches / functions / lines |
| `src/lib/state-machine.ts` | 100% statements / branches / functions / lines |

Run `npm run test:coverage` and confirm both files report 100% and the command exits 0.

## Phase re-verification (Phase 25)

```bash
cd backend && npm test -- tests/policy.evaluate.test.ts
cd backend && npm test -- tests/payments.create-order.test.ts tests/payments.verify.test.ts tests/webhooks.razorpay.test.ts tests/payments.reconcile.test.ts
cd backend && npm test -- tests/security
```

## Seed / reset before demos

```bash
npm run demo:reset
```

## Known E2E scope note

Playwright suites cover happy-path purchase and several negative paths (approval, checkout doubles, pre-payment). Backend integration tests cover the full Section 29 matrix (policy denial, approval reject, payment failure, duplicate webhook, expired approval, amount tampering, IDOR). Treat backend security + payments suites as the CI source of truth for money-path negatives when live Razorpay keys are unavailable.
