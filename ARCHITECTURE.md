# Architecture

CommercePilot is a modular monolith: one Express API, one React SPA, one Postgres database. The architectural claim is not “an LLM that can buy things,” but a hard separation between **probabilistic proposal** and **deterministic authorization**.

## Pipeline

```
User text
  → Intent Agent (LLM, schema-validated structured intent)
  → Discovery (deterministic catalog query)
  → Ranking (deterministic scores + optional LLM narration of stored numbers)
  → Policy Engine (deterministic; SQL-backed counters / limits)
  → Approval Service (human gate when required)
  → Payment Service (Razorpay Orders.create — never called by the LLM)
  → Checkout (browser, public key_id only)
  → Verify (HMAC) → provisional PAYMENT_AUTHORIZED
  → Webhook (HMAC over raw body) → COMPLETED
  → Audit timeline + Explain (grounded in stored factors)
```

## LLM vs deterministic (PRD §12–14)

| Layer | LLM? | Responsibility |
|---|---|---|
| Intent extraction | Yes | Propose structured fields; zod-validated; reject unknown enums |
| Discovery | No | Filter catalog by category / budget / stock |
| Ranking scores | No | Price fit, preference, quality, specs, merchant trust |
| Ranking explanation | Optional LLM | Narrate numbers already in `agent_decisions`; ungrounded numbers → template fallback |
| Policy Engine | No | ALLOW / REQUIRE_APPROVAL / DENY from policy rows + spend counters |
| Approvals | No | Single-consume + TTL; bound to `purchaseIntentId` |
| Orders / Payments / Webhooks | No | Amount from catalog product price; signature + webhook authoritative |
| State machine | No | Only legal transitions (PRD §19); illegal events throw |

**Invariant:** Intent/Ranking modules must not import Payments, Approvals, or Orders write paths (enforced by import-graph tests). The Orchestrator coordinates policy/approvals but still does not call Razorpay or `prisma.order.create`.

## Payment state machine (high level)

Purchase intent / order states progress only via named events (e.g. `policy_evaluated_allow`, `approved`, `order_created`, `signature_verified`, `webhook_captured`). Terminal and illegal transitions are rejected — so a spoofed webhook cannot “complete” a `POLICY_DENIED` intent that never received an order id.

## Frontend surfaces (routed)

| Route | Screen |
|---|---|
| `/` | Landing |
| `/login`, `/register` | Auth |
| `/policy` | Financial Policy Settings (customer) |
| `/shop` … `/shop/:intentId/*` | AI shop, compare, review, pay, success, timeline |
| `/approvals`, `/approvals/:id` | Approval Screen |
| `/merchant` | Merchant Dashboard (analytics) |
| `/products` | Product management (merchant_admin) |

## Data ownership

- Customers own purchase intents, approvals, policies, and their payment attempts.
- Merchant admins are scoped to `req.user.merchantId` for catalog writes and `/analytics/merchant`.
- Cross-user / cross-merchant access returns **404** (not 403) to avoid existence leaks.
