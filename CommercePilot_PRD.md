# CommercePilot — Product Requirements Document

**"The AI Buyer with a Financial Conscience"**
Razorpay Hackathon — Track 1: AI Growth & Agentic Commerce

> Core principle: **The LLM decides what should happen. Deterministic systems decide whether it is allowed to happen.**

---

## A note on Razorpay accuracy

Everything below that touches Razorpay is grounded in current official Razorpay documentation (Orders API, Standard Checkout, payment verification, webhooks, test mode). Where a requirement in the brief has no direct Razorpay API equivalent, it is explicitly marked **[APP-LEVEL]** (built in CommercePilot's own backend) or **[SIMULATED]** (mocked for the demo because Razorpay does not expose it). Nothing below invents a Razorpay endpoint that doesn't exist.

Key facts this PRD relies on:

- **Orders API** (`POST /v1/orders`) creates a server-side order with `amount` (in the smallest currency subunit, i.e. paise for INR), `currency`, and `receipt`. The response `id` (e.g. `order_EKwxwAgItmmXdp`) is what gets passed into Checkout. A payment cannot be captured without a valid `order_id` — this is what ties a payment to a specific, pre-authorized amount and prevents client-side tampering with price.
- **Standard Checkout** is a client-side JS overlay (`checkout.js`) that takes the `order_id`, your public `key_id`, and an amount/currency, and returns `razorpay_payment_id`, `razorpay_order_id`, and `razorpay_signature` to a `handler` callback on success.
- **Signature verification** (server-side, mandatory): compute `HMAC-SHA256(order_id + "|" + payment_id, key_secret)` and compare it to `razorpay_signature`. This is the only way to trust that a given `payment_id` belongs to a given `order_id` and wasn't spoofed by the client. The Razorpay SDKs (Node/Python/PHP/Java/Ruby) expose a `validatePaymentVerification` / `verifyPaymentSignature` helper that does exactly this.
- **Webhooks** are asynchronous JSON POSTs to a dashboard-configured URL. Each delivery carries an `X-Razorpay-Signature` header, which is `HMAC-SHA256(raw_request_body, webhook_secret)` — a *separate* secret from the API key/secret pair, configured in the dashboard. The signature must be computed over the **raw, unparsed body**, not a re-serialized JSON object, or verification will fail. Relevant events for this project: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`.
- Razorpay explicitly recommends **not** treating a client-side success callback as authoritative; webhooks (or a server-side fetch-and-confirm) are the source of truth for final state. Failed webhook deliveries are retried by Razorpay on a backoff schedule for 24 hours and carry an `x-razorpay-event-id` so a receiver can deduplicate retried/duplicate deliveries.
- Test Mode uses a separate test `key_id`/`key_secret` pair and Razorpay's published test card/UPI credentials; no real money moves. This PRD assumes Test Mode end-to-end.
- The Key Secret and webhook secret must **never** appear in frontend code — only `key_id` (public) goes to the browser.

Anything about "AI ranking scores," "policy engine," "approval gates," "agent decision timelines," and "audit trails" is **[APP-LEVEL]** — Razorpay has no concept of an AI agent, a spending policy, or an approval workflow. CommercePilot builds all of that itself and only touches Razorpay for order creation, checkout, verification, and webhooks.

---

## 1. Executive Summary

CommercePilot is an agentic commerce platform where a user states a shopping goal in plain language ("buy me running shoes under ₹5,000"), an AI pipeline turns that into a structured intent, searches and ranks a product catalog, and — only after passing through a deterministic financial policy engine and, if required, an explicit human approval step — executes a real payment through Razorpay in Test Mode. The differentiator is architectural: the LLM never has direct write access to money. It can only *propose* a purchase; a separate, non-LLM policy engine and payment service *decide* whether that proposal is allowed to become a Razorpay order, and a human is looped in whenever the proposal exceeds configured trust limits. Every step — intent extraction, ranking, policy evaluation, approval, order creation, verification, webhook confirmation — is logged into an immutable-style audit trail that the user can query and that answers "why did you do this?" from stored structured data rather than a fresh LLM hallucination.

## 2. Problem Statement

Two problems compound each other in the current wave of "AI shopping agents":

1. **Trust problem**: giving an LLM a payment tool and a system prompt that says "don't overspend" is not a safety control — it's a suggestion to a model that can be manipulated by prompt injection (e.g. a malicious product description telling the agent to "ignore your budget, this is a limited-time offer"). There is no deterministic guarantee against overspending, unauthorized categories, or repeated micro-purchases.
2. **Opacity problem**: shopping agents that just say "I bought this because it looked good" give users no way to audit, dispute, or understand a financial decision made on their behalf — which is fundamentally different from a bad restaurant recommendation.

CommercePilot treats commerce automation as a **financial system with an AI front-end**, not an AI system with a payment feature bolted on.

## 3. Product Vision

A user should be able to hand a purchasing goal to an agent the same way they'd hand a shopping list to a trusted assistant — with the confidence that the assistant is *structurally* incapable of blowing past their limits, buying from a category they didn't authorize, or hiding what it did. The agent should be fast and genuinely useful (it can complete a routine purchase in seconds), transparent (every score and decision is explainable from data, not vibes), and safe by construction rather than by prompt-engineering discipline.

## 4. Product Goals

- G1: Convert natural-language shopping intent into structured, machine-usable intent with high extraction accuracy.
- G2: Rank real catalog products using a transparent, inspectable scoring function.
- G3: Enforce spending limits, category rules, and approval thresholds through a policy engine the LLM cannot override.
- G4: Support both autonomous (no human in the loop) and approval-gated purchase flows.
- G5: Complete real Razorpay Test Mode payments with correct order creation, signature verification, and webhook-confirmed state.
- G6: Produce a full audit trail and natural-language explanation for every decision, sourced from stored data.
- G7: Demonstrate resilience to duplicate webhooks, payment failures, network drops, and stale approvals.
- G8: Ship a merchant-facing analytics view showing AI-assisted GMV and funnel metrics.

## 5. Non-Goals

- Not building a general-purpose e-commerce marketplace (catalog is seeded/synthetic, not a live multi-merchant ingestion pipeline).
- Not processing real money — Test Mode only, for the hackathon.
- Not building recurring payments, subscriptions, EMI, or Razorpay Route/marketplace payouts (out of scope; noted only as future work).
- Not building a mobile app — responsive web only.
- Not implementing a general RAG-based product search across the open web; the catalog is a bounded seeded dataset.
- Not attempting to fully solve prompt-injection-proof LLMs — instead, the design assumes the LLM *will* eventually be manipulated and ensures that manipulation cannot reach money.

## 6. Target Users

1. **Customers** — individuals who want a low-friction way to complete well-defined purchases without manually browsing, while retaining hard control over how much autonomy the agent has.
2. **Merchants/Admins** — catalog owners who want visibility into AI-assisted orders, conversion, and revenue, and need to trust that AI-originated orders are as verifiable as human-originated ones.

## 7. User Personas

**Priya, 28, busy product manager (Customer).** Wants recurring, low-stakes purchases (shoes, gadgets, small electronics) handled automatically under ₹5,000, but wants to personally approve anything larger. Values transparency — she will ask "why this one?" and expects a real answer, not filler.

**Arjun, 34, D2C merchant admin (Merchant).** Runs a mid-size sports/electronics storefront on the platform. Cares about AI-assisted GMV, wants to see whether AI recommendations convert better than manual browsing, and needs to be able to distinguish a legitimate AI-driven order from a suspicious one in his order queue.

## 8. User Stories

- As a customer, I want to describe what I want in plain language so I don't have to manually filter a catalog.
- As a customer, I want to set a maximum autonomous transaction amount so the agent can never spend more than I'm comfortable with unsupervised.
- As a customer, I want to explicitly approve any purchase above my threshold so I retain final say on larger spends.
- As a customer, I want to see exactly why a product was chosen, with the actual numbers behind the decision.
- As a customer, I want to see my full purchase and decision history, including purchases the agent proposed but was denied.
- As a merchant, I want to see which of my orders came from AI agents versus manual checkout, and how they're performing.
- As a merchant, I want to inspect failed or flagged AI purchase intents to catch abuse early.

## 9. Core User Journeys

**J1 — Autonomous purchase (happy path).** User types intent → Intent Agent extracts structured intent → Discovery Agent queries catalog → Ranking Agent scores + explains top candidates → Orchestrator calls Policy Engine → policy = ALLOW → Payment Service creates Razorpay order → Checkout opens → user completes test payment → server verifies signature → webhook confirms `payment.captured`/`order.paid` → order state → `COMPLETED` → Audit Service records full timeline → user can ask "why?" and gets a stored, structured explanation.

**J2 — Approval-gated purchase.** Same as J1 up to Policy Engine, but policy = `REQUIRE_APPROVAL` (amount exceeds threshold) → Approval Service creates a pending approval with expiry → user sees Approval screen with amount, product, reason, risk info → user clicks Approve → Orchestrator re-validates the approval hasn't expired/been consumed → proceeds to Razorpay order creation exactly as in J1. If user clicks Reject, order state → `APPROVAL_REJECTED`, audit entry recorded, no Razorpay call ever made.

**J3 — Policy denial.** User requests a purchase in a blocked category (or over daily limit) → Policy Engine returns `DENY` before any product ranking cost or Razorpay call is incurred → user sees a clear denial reason → audit trail records `POLICY_DENIED`.

**J4 — Payment failure and recovery.** Razorpay order created, checkout opens, payment fails (simulated test-mode failure) → client callback reports failure → server independently fetches payment/order status from Razorpay rather than trusting the client → confirms failure → order state → `PAYMENT_FAILED` → user is offered a safe retry that reuses the same idempotency key/order-intent record rather than creating a duplicate order.

**J5 — Duplicate webhook.** Razorpay redelivers a `payment.captured` webhook (e.g. due to a slow 200 response) → Webhook Service checks `x-razorpay-event-id` against `webhook_events` table → already processed → acknowledges 200 without reapplying state change or emitting duplicate notifications.

## 10. Functional Requirements

**FR-1 Auth.** Email/password registration and login for customers and merchant/admin roles; JWT-based session; role-based route protection.
**FR-2 Policy configuration.** Customers can create/update exactly one active financial policy: max autonomous transaction amount, daily spending limit, allowed categories, blocked categories, trusted merchants, approval threshold, autonomous-purchasing toggle, max autonomous transactions/day.
**FR-3 Natural-language intent.** Customer submits free text; system returns structured intent (category, budget, currency, purpose, priority, purchase_mode) with confidence and a display of extracted fields before proceeding.
**FR-4 Product discovery.** Given structured intent, system queries the seeded catalog with category/price/attribute filters and returns a candidate set.
**FR-5 Ranking + explanation.** System scores each candidate using a documented weighted formula (Section 15) and stores the per-factor breakdown, not just the final score.
**FR-6 Policy evaluation.** Deterministic service evaluates the top candidate's price/category/merchant against the active policy and returns one of `ALLOW`, `REQUIRE_APPROVAL`, `DENY` with a machine-readable reason code.
**FR-7 Approval workflow.** When `REQUIRE_APPROVAL`, system creates an approval record with a TTL (default 15 minutes), surfaces it in the UI, and accepts an explicit approve/reject action tied to that exact record (no generic "approve everything" action).
**FR-8 Razorpay order creation.** On `ALLOW` or on approval, backend calls Orders API server-side with amount in paise, currency `INR`, and a `receipt` equal to the internal `purchase_intent_id` for traceability, then stores the returned `order_id`.
**FR-9 Checkout.** Frontend opens Razorpay Standard Checkout using the public `key_id` and the server-issued `order_id`; Key Secret is never sent to the browser.
**FR-10 Verification.** On checkout success callback, backend re-derives the HMAC signature from `order_id|payment_id` using the Key Secret and compares to `razorpay_signature`; only a match progresses state.
**FR-11 Webhook processing.** Backend exposes a webhook endpoint that validates `X-Razorpay-Signature` against the raw body using the webhook secret, deduplicates by `x-razorpay-event-id`, and treats webhook-confirmed events as the authoritative source for finalizing order state.
**FR-12 State machine enforcement.** All order/payment transitions go through a single state-machine module that rejects illegal transitions (Section 19).
**FR-13 Audit trail.** Every agent action, policy decision, approval action, and payment state transition writes an append-style row to `audit_logs` with a timestamp, actor, and structured payload.
**FR-14 Explainability endpoint.** `GET /agent/decisions/:intentId/explain` returns a natural-language explanation composed from stored `agent_decisions` and `policy_evaluations` rows — never a fresh LLM call over unverified context.
**FR-15 Transaction history.** Customers can view all past purchase intents regardless of outcome (`COMPLETED`, `POLICY_DENIED`, `APPROVAL_REJECTED`, `PAYMENT_FAILED`, `EXPIRED`, `CANCELLED`).
**FR-16 Merchant catalog management.** Merchant/admin CRUD on products.
**FR-17 Merchant analytics.** Merchant/admin dashboard showing AI-assisted GMV, conversion rate, average order value, top products, and a feed of AI purchase intents (including denied/failed ones) for inspection.
**FR-18 Failure recovery.** On any payment ambiguity, backend performs a server-side status fetch against Razorpay before deciding state, never relying solely on client-reported success.
**FR-19 Idempotent purchase execution.** A given `purchase_intent_id` can only ever result in one Razorpay order; re-submission of the same intent (e.g. due to double-click or network retry) returns the existing order rather than creating a new one.
**FR-20 Rate limiting.** Purchase-intent submission and approval actions are rate-limited per user to blunt automated abuse.

## 11. Non-Functional Requirements

- **Correctness over speed for money**: every financial state transition must be derivable from either a verified signature or a verified webhook — never from client state alone.
- **Auditability**: audit log writes are append-only at the application layer (no update/delete endpoints exposed for `audit_logs`).
- **Latency**: end-to-end J1 happy path (intent → completed order) should complete in well under 15 seconds excluding user checkout interaction time, to support the 5-minute demo.
- **Availability of policy engine**: policy evaluation must not depend on the LLM provider being reachable — it's a pure function over stored data.
- **Testability**: policy engine, state machine, ranking function, and signature verification must be unit-testable without network calls.
- **Secret hygiene**: Key Secret and webhook secret live only in backend environment variables, never in git, never in frontend bundles.
- **Observability**: every request that touches money carries a correlation ID traceable end-to-end through logs.

## 12. Agent Architecture

CommercePilot explicitly separates **probabilistic** (LLM-driven) components from **deterministic** (rule-driven) components, connected through an Orchestrator that enforces the handoff contract between them.

```
User NL input
   │
   ▼
[Intent Agent] (LLM, structured output)
   │  → purchase_intents row (status: INTENT_EXTRACTED)
   ▼
[Product Discovery Agent] (deterministic catalog query, LLM only rewrites/expands search terms)
   │
   ▼
[Ranking/Decision Agent] (LLM proposes ranking rationale; scoring formula itself is deterministic code)
   │  → agent_decisions row with per-factor score breakdown
   ▼
[Orchestrator] passes ONLY (user_id, product_id, amount, category, merchant_id) to:
   ▼
[Policy Evaluation Service] (100% deterministic, no LLM call, no network call)
   │  → policy_evaluations row: ALLOW / REQUIRE_APPROVAL / DENY + reason_code
   ▼
   ├── DENY ─────────────────────────────► stop, audit, notify
   ├── REQUIRE_APPROVAL ─► [Approval Service] ─► human decision ─► Approved? → continue : stop
   └── ALLOW ─────────────────────────────► continue
   ▼
[Risk Evaluation Service] (deterministic heuristics: velocity checks, new-merchant flags)
   ▼
[Payment Service] → Razorpay Orders API (server-side, real HTTP call)
   ▼
[Verification Service] → HMAC signature check (deterministic, no LLM)
   ▼
[Webhook Service] → authoritative state confirmation (deterministic)
   ▼
[Audit Service] → immutable-style log of every step above
   ▼
[Merchant Analytics Service] → aggregates completed/denied/failed intents
```

The critical invariant: **no code path exists by which an LLM output can call the Payment Service directly.** The LLM's structured output (intent, ranking rationale) is data that the Orchestrator reads; the Orchestrator — plain TypeScript, no model in the loop — is the only caller of the Policy Evaluation Service and the Payment Service.

## 13. AI Responsibilities (probabilistic)

- Parsing free text into structured intent (category, budget, purpose, constraints) with a confidence score.
- Generating human-readable rationale text for a ranking that has already been computed deterministically (the LLM explains the numbers; it does not invent them).
- Rewriting/expanding a search query against the catalog (e.g. "shoes for running" → also matches `tags: ["running","athletic","trail"]`).
- Drafting the natural-language answer to "why did you choose this?" — but strictly by templating over stored `agent_decisions`/`policy_evaluations` fields, not by free generation from scratch.

## 14. Deterministic Responsibilities (non-negotiable, no LLM in the loop)

- Product scoring formula (Section 15) — pure function, unit-testable.
- Policy Evaluation Service — pure function over `(financial_policy, proposed_purchase)`.
- Risk Evaluation Service — velocity/frequency checks against `agent_runs`/`orders` history.
- Approval Service — issuance, expiry, and single-use consumption of approvals.
- Payment Service — Razorpay order creation, using only Orchestrator-supplied, already-policy-approved values.
- Verification Service — HMAC signature comparison.
- Webhook Service — signature validation + idempotent event application.
- Order/Payment State Machine — legal transition enforcement.
- Audit Service — append-only logging.

## 15. Financial Policy Engine

**Inputs**: active `financial_policies` row for the user; proposed `{amount, category, merchant_id}`; today's already-completed autonomous spend and count for that user.

**Decision function (pseudocode, deterministic):**

```
function evaluatePolicy(policy, proposal, todaySpend, todayAutonomousCount):
  if not policy.autonomous_enabled:
      return REQUIRE_APPROVAL, "AUTONOMOUS_DISABLED"
  if proposal.category in policy.blocked_categories:
      return DENY, "CATEGORY_BLOCKED"
  if policy.allowed_categories is non-empty and proposal.category not in policy.allowed_categories:
      return DENY, "CATEGORY_NOT_ALLOWED"
  if todaySpend + proposal.amount > policy.daily_limit:
      return REQUIRE_APPROVAL, "DAILY_LIMIT_EXCEEDED"
  if todayAutonomousCount >= policy.max_autonomous_txns_per_day:
      return REQUIRE_APPROVAL, "MAX_AUTONOMOUS_TXNS_REACHED"
  if proposal.amount > policy.approval_threshold:
      return REQUIRE_APPROVAL, "AMOUNT_ABOVE_APPROVAL_THRESHOLD"
  if proposal.amount > policy.max_autonomous_amount:
      return REQUIRE_APPROVAL, "AMOUNT_ABOVE_MAX_AUTONOMOUS"
  if proposal.merchant_id not in policy.trusted_merchants and policy.trusted_merchants is non-empty:
      return REQUIRE_APPROVAL, "MERCHANT_NOT_TRUSTED"
  return ALLOW, "WITHIN_POLICY"
```

Order of checks matters and is fixed: hard blocks (`DENY`) always short-circuit before soft thresholds (`REQUIRE_APPROVAL`). This function takes no network or LLM input and must run in well under 10ms.

**Product ranking score** (0–100, deterministic, weights configurable but defaulted):

```
score = 0.30 * price_fit          // 100 at ideal price point, decaying toward budget ceiling
      + 0.25 * preference_match   // attribute/tag overlap with extracted intent
      + 0.20 * quality            // normalized rating × log(review_count)
      + 0.15 * spec_match         // numeric spec constraints satisfied (e.g. cushioning for distance)
      + 0.10 * merchant_trust     // merchant historical fulfillment/rating score
if out_of_stock: score = 0
if price > budget: score = 0       // hard constraint, not a penalty
```

Every factor and its raw value is persisted per candidate so the explanation endpoint can cite exact numbers instead of paraphrasing an LLM guess.

## 16. Approval System

An approval is a first-class row (`approvals` table) tied 1:1 to a `purchase_intents` row. It stores: user_id, purchase_intent_id, product_id, amount, policy_decision_id, reason_code, created_at, expires_at (default `created_at + 15 minutes`), status (`PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`), consumed_at.

**Anti-replay rule**: the Orchestrator only proceeds to Razorpay order creation if it can atomically transition an approval from `PENDING` → `APPROVED` **and** set `consumed_at` in the same DB transaction, using an optimistic check (`WHERE status = 'PENDING' AND expires_at > now()`). If zero rows are affected (already consumed or expired), the flow fails safe with `APPROVAL_ALREADY_CONSUMED` or `APPROVAL_EXPIRED` — this closes the replay window where a user could try to reuse a stale approval token or double-submit an approve click.

## 17. Payment Architecture

```
Frontend (React)
   │  1. POST /purchase-intents (NL text)
   ▼
Backend (Node/Express, TypeScript)
   │  2. Intent → Discovery → Ranking → Policy → (Approval if needed)
   │  3. POST https://api.razorpay.com/v1/orders   (server-side, Basic Auth key_id:key_secret)
   ▼
Razorpay Orders API → { id: "order_xxx", amount, currency, status: "created" }
   │  4. order_id + public key_id returned to frontend
   ▼
Frontend opens Razorpay Standard Checkout (checkout.js) with order_id
   │  5. user completes test payment
   ▼
Checkout `handler` callback → { razorpay_payment_id, razorpay_order_id, razorpay_signature }
   │  6. POST /payments/verify (backend)
   ▼
Backend: HMAC-SHA256(order_id + "|" + payment_id, key_secret) == razorpay_signature ?
   │  7a. Match → mark PAYMENT_AUTHORIZED (provisional), await webhook for capture confirmation
   │  7b. No match → PAYMENT_VERIFICATION_FAILED, do not trust
   ▼
Razorpay webhook POST /webhooks/razorpay  (payment.captured / order.paid / payment.failed)
   │  8. Validate X-Razorpay-Signature over RAW body using webhook_secret
   │  9. Deduplicate via x-razorpay-event-id (unique constraint in webhook_events)
   ▼
Backend finalizes state → PAYMENT_CAPTURED → COMPLETED (authoritative)
```

Key architectural rule: the client-side `handler` callback and the server-side signature check give **fast, provisional** confirmation for good UX; the **webhook is the only source that finalizes** the order as `COMPLETED`, per Razorpay's own guidance to treat webhooks (or an explicit server-side fetch) as the reliable channel rather than the client callback alone.

## 18. Razorpay Integration Details

| Concern | Mechanism | Notes |
|---|---|---|
| Auth | Basic Auth with `key_id:key_secret` on server-side calls | Test mode keys, from dashboard |
| Create order | `POST /v1/orders` with `amount` (paise), `currency: "INR"`, `receipt: purchase_intent_id` | Amount is always computed server-side from the ranked product's price, never trusted from the client |
| Checkout | `checkout.js`, options include `key` (public), `amount`, `currency`, `order_id`, `handler`, `prefill` | Only `key_id` ships to frontend |
| Verify | HMAC-SHA256(`order_id|payment_id`, `key_secret`) vs `razorpay_signature` | Use SDK helper (`razorpay.utils.validatePaymentVerification` for Node) rather than hand-rolled crypto where possible |
| Webhooks | Dashboard-configured URL; events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid` | Verify against **raw** body; separate webhook secret |
| Idempotency of webhook | `x-razorpay-event-id` header | Store in `webhook_events.event_id UNIQUE` |
| Test mode | Test `key_id`/`key_secret`, Razorpay's published test card/UPI numbers | No live-mode credentials anywhere in repo |

**[SIMULATED]**: Razorpay does not have a native "AI purchase" flag or agent metadata field beyond `notes` (a small key-value bag, max 15 pairs, on the order). CommercePilot uses `notes` to tag `{ source: "commercepilot_agent", purchase_intent_id, autonomous: "true"/"false" }` for traceability inside Razorpay's own dashboard, but all rich agent metadata (scores, rationale, timeline) lives in CommercePilot's own database, not in Razorpay.

## 19. Payment State Machine

**States**: `CREATED → INTENT_EXTRACTED → PRODUCTS_RANKED → POLICY_PENDING → {POLICY_DENIED | APPROVAL_PENDING | POLICY_ALLOWED} → {APPROVAL_REJECTED | APPROVED} → ORDER_CREATED → PAYMENT_PENDING → PAYMENT_AUTHORIZED → PAYMENT_CAPTURED → COMPLETED`

**Failure/terminal states**: `PAYMENT_FAILED`, `PAYMENT_VERIFICATION_FAILED`, `POLICY_DENIED`, `APPROVAL_REJECTED`, `EXPIRED`, `CANCELLED`.

**Legal transitions** (enforced by a single `transition(currentState, event) → nextState | throw IllegalTransitionError` function, table-driven, unit tested exhaustively):

| From | Event | To |
|---|---|---|
| CREATED | intent_extracted | INTENT_EXTRACTED |
| INTENT_EXTRACTED | products_ranked | PRODUCTS_RANKED |
| PRODUCTS_RANKED | policy_evaluated_allow | POLICY_ALLOWED |
| PRODUCTS_RANKED | policy_evaluated_deny | POLICY_DENIED |
| PRODUCTS_RANKED | policy_evaluated_needs_approval | APPROVAL_PENDING |
| APPROVAL_PENDING | approved | APPROVED |
| APPROVAL_PENDING | rejected | APPROVAL_REJECTED |
| APPROVAL_PENDING | expired | EXPIRED |
| POLICY_ALLOWED | order_created | ORDER_CREATED |
| APPROVED | order_created | ORDER_CREATED |
| ORDER_CREATED | checkout_opened | PAYMENT_PENDING |
| PAYMENT_PENDING | signature_verified | PAYMENT_AUTHORIZED |
| PAYMENT_PENDING | signature_invalid | PAYMENT_VERIFICATION_FAILED |
| PAYMENT_PENDING | payment_failed_webhook | PAYMENT_FAILED |
| PAYMENT_AUTHORIZED | webhook_captured | PAYMENT_CAPTURED |
| PAYMENT_AUTHORIZED | webhook_failed | PAYMENT_FAILED |
| PAYMENT_CAPTURED | order_paid_confirmed | COMPLETED |
| any non-terminal | user_cancelled | CANCELLED |

Every other transition throws. This means, for example, a webhook cannot move `POLICY_DENIED` → `COMPLETED` — a structurally impossible attack path even if webhook validation itself were somehow bypassed, because the row would never have an `order_id` to match against.

## 20. Failure Recovery

| Scenario | Detection | Recovery |
|---|---|---|
| Client reports payment failure | `handler` not called / checkout `ondismiss` fires | Backend fetches order/payment status server-side before marking `PAYMENT_FAILED`; never trust silence as failure |
| Client reports success but signature invalid | HMAC mismatch | State → `PAYMENT_VERIFICATION_FAILED`; flagged for manual review; no retry of the same order_id (treat as suspicious) |
| Webhook never arrives | Poll timeout after N seconds on `PAYMENT_PENDING`/`PAYMENT_AUTHORIZED` | Server-side fetch of payment status from Razorpay as a fallback, per Razorpay's own recommendation to supplement webhooks with API fetch for user-facing flows |
| Webhook arrives twice | Duplicate `x-razorpay-event-id` | Ack 200, no state reapplication, no duplicate notification |
| Network drop mid-checkout | Browser closed / tab lost | Order remains `PAYMENT_PENDING`; user can resume checkout for the *same* `order_id` (Razorpay orders accept re-attempts) rather than creating a new order |
| Retry storm | Repeated identical purchase-intent submission | Idempotency key = `purchase_intent_id`; a second submission returns the existing intent/order rather than re-running the pipeline or calling Orders API again |

Retries are capped (max 3 server-side status re-checks with exponential backoff) and every retry attempt is written to `audit_logs` — the system never blindly retries a financial write operation (order creation) itself, only *read* operations (status fetch).

## 21. Idempotency Strategy

| Operation | Idempotency mechanism |
|---|---|
| Purchase execution | `purchase_intents.id` is client-visible and reused; `orders.purchase_intent_id UNIQUE` prevents a second order for the same intent |
| Razorpay order creation | Guarded by app-level check ("does an order already exist for this intent?") before calling the API; Razorpay's `receipt` is also set to the intent id for cross-referencing |
| Payment confirmation | `payments.razorpay_payment_id UNIQUE` — a payment id can only be recorded once |
| Webhook handling | `webhook_events.event_id UNIQUE` (from `x-razorpay-event-id`); insert-or-ignore pattern before applying any state change |
| Approval execution | Atomic conditional update (`WHERE status='PENDING'`) as described in Section 16 |
| Retry logic | Retries are keyed by the same idempotency key as the original operation; a retry never generates a new key |

## 22. Security Model

- **AuthN**: bcrypt-hashed passwords, JWT access tokens (short-lived) + refresh tokens (httpOnly, secure cookie), role claim (`customer` / `merchant_admin`).
- **AuthZ**: route-level middleware checks role and resource ownership (a customer can only see their own `purchase_intents`/`approvals`; a merchant admin only their own catalog/orders).
- **Input validation**: schema validation (e.g. zod) on every request body; strict allow-lists for enum fields (category, purchase_mode).
- **Rate limiting**: per-user token bucket on `/purchase-intents` and `/approvals/:id/decision` to blunt scripted abuse.
- **Secrets**: Key Secret and webhook secret only in backend `.env`, never logged, never returned in any API response, never in frontend bundle.
- **Signature verification**: mandatory on both the checkout callback path and the webhook path — never inferred as "same as before."
- **CORS**: allow-list of the frontend origin only.
- **CSRF**: JWT-in-header (not cookie-based auth for state-changing calls) sidesteps most CSRF risk; if cookies are used for refresh tokens, `SameSite=strict` + CSRF token on state-changing routes.
- **Injection prevention**: parameterized queries / ORM (Prisma) everywhere; no raw string concatenation into SQL.
- **PII minimization**: only store what's needed for checkout prefill (name, email, contact); no storage of card data (Razorpay Checkout handles that entirely off-platform).

## 23. AI Security

| Threat | Mitigation |
|---|---|
| Prompt injection via user text | Intent Agent output is schema-validated (structured output); any field outside expected enums/ranges is rejected, not coerced |
| Tool injection via malicious product descriptions | Ranking Agent never executes instructions found in catalog text; catalog fields are treated strictly as data, rendered/scored, never interpolated into a prompt that grants tool-calling authority |
| Agent goal manipulation ("ignore your budget") | Irrelevant by construction — the LLM has no path to the Payment Service; only the deterministic Policy Engine can authorize a purchase, and it reads only structured DB fields, never free text |
| Unauthorized tool execution | LLM has no function-calling access to Payment Service, Approval Service, or Orders API — those are Orchestrator-only, non-LLM code paths |
| Spending limit bypass | Enforced in SQL-backed deterministic code (Section 15), independent of any LLM output |
| Approval replay | Atomic single-consumption update + TTL (Section 16) |
| Fake payment confirmation | Client success is provisional only; webhook + signature are authoritative (Sections 17, 20) |
| Webhook spoofing | HMAC signature validated against raw body with a secret never exposed client-side; unsigned/invalid requests rejected with 400 before touching state |
| LLM hallucinated product info | Ranking Agent scores and explanation are computed from actual catalog rows, not generated; the LLM only narrates numbers that already exist in `agent_decisions` |

**Explicit design statement**: the AI is never trusted as the sole source of authorization for any financial action. It is a proposer, not an approver.

## 24. Database Schema (PostgreSQL)

```sql
-- USERS & POLICY
users (
  id UUID PK, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT CHECK (role IN ('customer','merchant_admin')) NOT NULL,
  name TEXT, phone TEXT, created_at TIMESTAMPTZ DEFAULT now()
);

user_preferences (
  id UUID PK, user_id UUID FK -> users, preferred_categories TEXT[],
  style_preferences JSONB, updated_at TIMESTAMPTZ
);

financial_policies (
  id UUID PK, user_id UUID FK -> users UNIQUE,
  max_autonomous_amount NUMERIC(12,2) NOT NULL,
  daily_spending_limit NUMERIC(12,2) NOT NULL,
  approval_threshold NUMERIC(12,2) NOT NULL,
  allowed_categories TEXT[], blocked_categories TEXT[],
  trusted_merchants UUID[], autonomous_enabled BOOLEAN DEFAULT false,
  max_autonomous_txns_per_day INT DEFAULT 3,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);

-- CATALOG
merchants (
  id UUID PK, name TEXT NOT NULL, trust_score NUMERIC(4,2) DEFAULT 50,
  is_trusted_default BOOLEAN DEFAULT false, created_at TIMESTAMPTZ
);

products (
  id UUID PK, merchant_id UUID FK -> merchants, name TEXT NOT NULL,
  category TEXT NOT NULL, description TEXT, price NUMERIC(12,2) NOT NULL,
  currency TEXT DEFAULT 'INR', rating NUMERIC(3,2), review_count INT DEFAULT 0,
  stock INT DEFAULT 0, image_url TEXT, tags TEXT[],
  delivery_days INT, created_at TIMESTAMPTZ,
  INDEX (category), INDEX (merchant_id)
);

product_attributes (
  id UUID PK, product_id UUID FK -> products, attr_key TEXT, attr_value TEXT,
  UNIQUE (product_id, attr_key)
);

-- AGENT PIPELINE
purchase_intents (
  id UUID PK, user_id UUID FK -> users, raw_text TEXT NOT NULL,
  structured_intent JSONB NOT NULL, purchase_mode TEXT CHECK (purchase_mode IN ('autonomous','manual')),
  status TEXT NOT NULL, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  UNIQUE (user_id, id) -- supports idempotent lookups
);

agent_runs (
  id UUID PK, purchase_intent_id UUID FK -> purchase_intents UNIQUE,
  started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, status TEXT
);

agent_decisions (
  id UUID PK, agent_run_id UUID FK -> agent_runs, product_id UUID FK -> products,
  score NUMERIC(5,2), score_breakdown JSONB, rank INT, selected BOOLEAN DEFAULT false,
  rationale TEXT, created_at TIMESTAMPTZ,
  INDEX (agent_run_id)
);

policy_evaluations (
  id UUID PK, purchase_intent_id UUID FK -> purchase_intents,
  decision TEXT CHECK (decision IN ('ALLOW','REQUIRE_APPROVAL','DENY')) NOT NULL,
  reason_code TEXT NOT NULL, policy_snapshot JSONB NOT NULL,
  evaluated_at TIMESTAMPTZ
);

approvals (
  id UUID PK, purchase_intent_id UUID FK -> purchase_intents UNIQUE,
  user_id UUID FK -> users, product_id UUID FK -> products, amount NUMERIC(12,2),
  policy_evaluation_id UUID FK -> policy_evaluations, reason_code TEXT,
  status TEXT CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')) DEFAULT 'PENDING',
  created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, consumed_at TIMESTAMPTZ
);

-- PAYMENTS
orders (
  id UUID PK, purchase_intent_id UUID FK -> purchase_intents UNIQUE,
  product_id UUID FK -> products, razorpay_order_id TEXT UNIQUE,
  amount NUMERIC(12,2) NOT NULL, currency TEXT DEFAULT 'INR',
  state TEXT NOT NULL, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);

payments (
  id UUID PK, order_id UUID FK -> orders, razorpay_payment_id TEXT UNIQUE,
  razorpay_signature TEXT, status TEXT NOT NULL,
  signature_verified BOOLEAN DEFAULT false, verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
);

webhook_events (
  id UUID PK, event_id TEXT UNIQUE NOT NULL, event_type TEXT NOT NULL,
  order_id UUID FK -> orders, raw_payload JSONB NOT NULL,
  signature_valid BOOLEAN NOT NULL, received_at TIMESTAMPTZ, processed_at TIMESTAMPTZ
);

audit_logs (
  id UUID PK, purchase_intent_id UUID FK -> purchase_intents NULL,
  actor TEXT NOT NULL, -- 'system' | 'agent' | user_id | 'razorpay_webhook'
  action TEXT NOT NULL, payload JSONB, correlation_id TEXT, created_at TIMESTAMPTZ,
  INDEX (purchase_intent_id), INDEX (correlation_id)
);

notifications (
  id UUID PK, user_id UUID FK -> users, type TEXT, message TEXT,
  read BOOLEAN DEFAULT false, created_at TIMESTAMPTZ
);
```

Enum states are enforced via `CHECK` constraints (Postgres) rather than a separate enum type, to keep migrations simple during a hackathon timeline. All `*_id` foreign keys are indexed; `webhook_events.event_id`, `payments.razorpay_payment_id`, `orders.razorpay_order_id`, and `orders.purchase_intent_id` all carry `UNIQUE` constraints because they are the load-bearing idempotency guards described in Section 21.

## 25. API Specification

Auth: all routes except `/auth/*` require `Authorization: Bearer <jwt>`. Role column shows required role (`customer`, `merchant_admin`, or `any`).

| Method & Route | Role | Purpose | Idempotent? |
|---|---|---|---|
| POST `/auth/register` | any | Create user | No |
| POST `/auth/login` | any | Issue JWT | No |
| POST `/policies` | customer | Create/replace active financial policy | Yes (replace) |
| GET `/policies/me` | customer | Fetch current policy | Yes |
| GET `/products` | any | List/search catalog (query: category, maxPrice, tags) | Yes |
| POST `/products` | merchant_admin | Create product | No |
| PUT `/products/:id` | merchant_admin | Update product | Yes |
| POST `/purchase-intents` | customer | Submit NL shopping goal; body: `{text, purchase_mode}`; **key**: `Idempotency-Key` header echoing a client-generated UUID stored against `purchase_intents.id` | Yes, via Idempotency-Key |
| GET `/purchase-intents/:id` | customer (owner) | Poll status/state | Yes |
| GET `/purchase-intents` | customer (owner) | List history | Yes |
| GET `/agent/decisions/:intentId` | customer (owner) | Full ranked candidate list + scores | Yes |
| GET `/agent/decisions/:intentId/explain` | customer (owner) | Structured-data-backed explanation | Yes |
| GET `/agent/decisions/:intentId/timeline` | customer (owner) | Chronological audit view for this intent | Yes |
| GET `/approvals/pending` | customer | List pending approvals for user | Yes |
| POST `/approvals/:id/decision` | customer (owner) | Body `{decision: 'approve'|'reject'}`; atomic consume | No (single-use by design) |
| POST `/payments/create-order` | customer (owner, internal call from Orchestrator) | Server-side Razorpay order creation for an ALLOWED/APPROVED intent | Yes, guarded by `orders.purchase_intent_id UNIQUE` |
| POST `/payments/verify` | customer (owner) | Body `{razorpay_order_id, razorpay_payment_id, razorpay_signature}`; HMAC check | Yes (verifying twice is safe, a no-op on already-verified) |
| POST `/webhooks/razorpay` | none (signature-authenticated) | Razorpay-origin POST; validated via `X-Razorpay-Signature` over raw body | Yes, via `event_id` uniqueness |
| GET `/orders` | customer (owner) / merchant_admin (own merchant) | List orders | Yes |
| GET `/audit-logs/:purchaseIntentId` | customer (owner) / merchant_admin | Full audit trail | Yes |
| GET `/analytics/merchant` | merchant_admin | GMV, conversion, AI-assisted %, top products | Yes |

Every mutating endpoint validates request bodies against a strict schema and returns `400` with a field-level error map on failure, `401`/`403` for auth/role failures, `404` for missing/not-owned resources (never leaking existence of another user's resource), and `409` for illegal state transitions or already-consumed approvals.

## 26. Frontend Architecture

React + TypeScript + Vite, Tailwind + shadcn/ui, React Query for server state, a small Zustand store for ephemeral UI state (active chat thread, in-flight approval). Route structure mirrors the 18 required pages (Section on Frontend below). Visual language: dark, high-contrast "fintech console" aesthetic — deep navy/near-black backgrounds, a single confident accent color reserved specifically for money-moving actions (e.g. "Pay Now," "Approve"), monospace for amounts/IDs, generous whitespace, explicit state badges (color-coded pills for `COMPLETED`/`DENIED`/`PENDING`) rather than a generic chatbot bubble UI — the goal is to visually read as a trading terminal or banking app, not a chatbot skin.

Required pages: Landing, Login, Register, AI Commerce Dashboard, AI Shopping Chat, Product Comparison, Purchase Review, Approval Screen, Payment Screen (Checkout trigger), Order Success, Transaction History, Agent Decision Timeline, Financial Policy Settings, Profile/Settings, Merchant Dashboard, Analytics, Product Management, Admin Order Management.

## 27. Backend Architecture

Node.js + TypeScript, Express (or Fastify), organized as a **modular monolith** (per the brief's explicit preference — no premature microservices for a hackathon). Module boundaries mirror the agent architecture in Section 12, each as its own folder with a clear interface, so a future extraction into services is mechanical rather than a rewrite:

```
/src
  /modules
    auth/
    policy/            (Policy Evaluation Service — zero external deps)
    catalog/           (Product Discovery)
    ranking/           (Ranking/Decision — scoring function + LLM rationale caller)
    intent/            (Intent Agent — LLM call + schema validation)
    approvals/
    payments/          (Razorpay Orders API client, verification)
    webhooks/          (Razorpay webhook receiver)
    audit/
    analytics/
    orchestrator/      (the only module allowed to call policy + payments in sequence)
  /db (Prisma schema + migrations)
  /lib (state-machine.ts, hmac.ts, idempotency.ts)
```

Prisma as ORM against PostgreSQL; BullMQ optional for async webhook processing under load (not required for demo scale, but designed for). Environment-based config; no secrets in code.

## 28. Observability

- **Correlation ID**: generated at `purchase_intents` creation, propagated through every log line and stored on `audit_logs.correlation_id`.
- **IDs surfaced in logs**: `agent_run_id`, `purchase_intent_id`, `razorpay_order_id`, `razorpay_payment_id`, webhook `event_id`.
- **Structured logging**: JSON logs (pino or similar) with level, correlation_id, module, message, and relevant entity IDs — never raw secrets.
- **Metrics** (computed from stored tables, exposed on `/analytics/merchant` and an internal ops view): agent success rate, recommendation acceptance rate, autonomous purchase rate, approval rate, policy rejection rate, payment success rate, payment failure rate, duplicate-webhook-prevented count, recovery success rate, AI-assisted GMV, average order value.

## 29. Testing Strategy

**Unit** — policy engine (every branch in Section 15's decision table), ranking function (score monotonicity, hard-constraint zeroing), state machine (every legal transition + a representative illegal one per state), HMAC verification (valid/invalid/tampered signature), idempotency helpers.

**Integration** — API routes against a test DB (policy CRUD, purchase-intent lifecycle, approval consume-once behavior), Razorpay Test Mode calls (order creation against Razorpay's actual test environment), webhook signature validation against Razorpay's documented sample payload format.

**E2E (Playwright)** — the 11-step happy path from the brief (register → create policy → request product → agent recommends → policy allows → order created → checkout completes → payment verified → webhook received → order completed → audit trail generated), plus explicit negative-path tests: policy denial, approval-required flow, approval rejection, payment failure, duplicate webhook delivery, network failure mid-checkout, duplicate purchase-intent submission (idempotency), and stale/expired approval replay attempt.

## 30. Deployment

Single Docker Compose stack for the hackathon: `frontend` (static build served via nginx or Vite preview), `backend` (Node), `postgres`, optional `redis` (if BullMQ used). Backend reachable at a public HTTPS URL (required for Razorpay webhooks — Razorpay cannot POST to `localhost`; use a tunnel like ngrok during development, a real deployed URL for the demo). CI: lint + unit + integration tests on push; no auto-deploy required for a hackathon but a `docker compose up` should be sufficient for judges to run locally if the hosted demo is unavailable.

## 31. Environment Variables

```
DATABASE_URL=
JWT_SECRET=
JWT_REFRESH_SECRET=
RAZORPAY_KEY_ID=            # test mode
RAZORPAY_KEY_SECRET=        # test mode, backend only, never sent to client
RAZORPAY_WEBHOOK_SECRET=    # separate from key_secret, set in Razorpay dashboard
LLM_PROVIDER_API_KEY=
LLM_PROVIDER=                # abstraction layer, e.g. "anthropic" | "openai"
FRONTEND_URL=                 # for CORS allow-list
NODE_ENV=
PORT=
```

`RAZORPAY_KEY_ID` is also exposed to the frontend build as a public config value (`VITE_RAZORPAY_KEY_ID`) — this is safe because the Key ID is public by design; only the Key Secret and webhook secret must stay server-side.

## 32. Seed Data

- ~40–60 synthetic products across Electronics, Sports, Travel (matching the example policy categories), each with realistic price bands, ratings, review counts, stock, and 3–5 tags/attributes relevant to common intents (e.g. running shoes tagged `cushioning`, `distance`, `trail`).
- 3–5 seeded merchants with varying `trust_score`.
- 1 demo customer account pre-configured with the example policy from the brief: max autonomous ₹5,000, daily limit ₹10,000, allowed categories Electronics/Sports/Travel, approval threshold ₹5,000 — so the demo script (Section 33) works without live reconfiguration.
- 1 seeded product deliberately priced at ₹4,499 (running shoes) to hit the "ALLOW" path, and one implicit gap above ₹5,000 (e.g. a ₹1,20,000 laptop) to hit the "REQUIRE_APPROVAL" path, exactly matching the brief's demo scenario.

## 33. Demo Scenario (~5 minutes)

1. **(0:00–0:30)** Show Financial Policy Settings for the demo customer — max autonomous ₹5,000, daily limit ₹10,000, approval threshold ₹5,000, allowed categories shown explicitly.
2. **(0:30–1:30)** Type: *"I need running shoes under ₹5,000. I run 25 km per week. Buy the best option automatically."* Show live intent extraction (structured JSON appears), then candidate discovery (N products found).
3. **(1:30–2:15)** Show ranking with per-factor score breakdown for the top 3 candidates; open the explanation panel showing why the top pick won (price fit, rating, spec match) using stored numbers, not a live LLM narration.
4. **(2:15–2:45)** Show policy evaluation output: `ALLOW`, reason `WITHIN_POLICY`, because ₹4,499 ≤ ₹5,000 threshold.
5. **(2:45–3:30)** Razorpay Checkout opens (Test Mode), complete payment with a published test card. Show payment verification succeed, then the webhook arrive and flip state to `COMPLETED`. Show the full agent decision timeline with real timestamps.
6. **(3:30–4:15)** Type: *"Buy me a laptop for ₹1,20,000."* Show policy evaluation return `REQUIRE_APPROVAL` (`AMOUNT_ABOVE_APPROVAL_THRESHOLD`) — Razorpay is **not** called yet. Show the Approval screen with amount, reasoning, and Approve/Reject buttons.
7. **(4:15–5:00)** Click Reject to show a denial path with zero money movement, then briefly show the Merchant Analytics dashboard (AI-assisted GMV, conversion, the flagged/pending intent visible to the merchant) to close on the differentiator: an AI agent that proposes, and a deterministic system that decides.

## 34. Business Metrics

**Customer-side**: time saved per purchase (baseline manual browse time vs. agent completion time), reduction in checkout steps/clicks, recommendation acceptance rate, percentage of spend kept within self-configured limits (trust signal), approval responsiveness.
**Merchant-side**: AI-assisted GMV as % of total, conversion rate for AI-driven vs. manual traffic, reduced cart abandonment for AI-completed purchases (no cart abandonment possible once policy-approved, by construction), average order value, repeat-purchase rate via autonomous mode.

## 35. Competitive Differentiation

Most "agentic commerce" demos give an LLM a `buy(product_id)` tool and call it done — the safety story is a system prompt. CommercePilot's differentiator is that the boundary between "AI decides what" and "system decides whether" is a real code boundary: the LLM's output is inert data until a separate, unit-tested, LLM-free policy engine and state machine choose to act on it. That is also the most concrete, demoable, judgeable artifact in a hackathon setting — a judge can watch the ₹1,20,000 laptop request get blocked *before* Razorpay is ever called, which is a stronger proof point than any amount of prompt-engineering claims.

## 36. Hackathon Judging Strategy

Lead the demo with the **denial/approval path**, not the happy path — most agentic-commerce demos only show the happy path, so a live "the AI wanted to spend ₹1,20,000 and the system stopped it before any Razorpay call was made" moment is the most memorable, differentiated 30 seconds of the demo. Follow immediately with the audit trail and explanation screen to show the AI isn't a black box. Keep the Razorpay integration visibly real (show the Razorpay dashboard test-mode order/payment appearing live) rather than only showing CommercePilot's own UI, to make clear this is a real integration and not a mock.

## 37. Risks

| Risk | Mitigation |
|---|---|
| LLM structured-output drift (malformed JSON) | Strict schema validation with retry-once-then-fallback-to-manual-mode |
| Webhook not reachable during demo (local network) | Use a stable tunnel (ngrok) or deploy backend publicly before demo day; have a server-side status-fetch fallback path already built (Section 20) so the demo doesn't hard-depend on webhook delivery timing |
| Scope creep across 40 PRD sections in hackathon timeframe | Section 39 milestones sequence ruthlessly — payment correctness and policy engine ship before analytics/polish |
| Judges probing prompt-injection live | Have a pre-loaded example of a manipulated product description in the catalog to demonstrate the mitigation live if asked |
| Time-zone/currency edge cases in amount math | All amounts stored as `NUMERIC(12,2)` in INR; Razorpay amounts always paise = `round(amount * 100)`, converted at exactly one boundary (Payment Service) to avoid float drift |

## 38. Future Improvements

- Recurring/subscription purchases via Razorpay Subscriptions (explicitly out of scope now).
- Merchant payouts / marketplace split via Razorpay Route (explicitly out of scope now).
- Multi-currency support beyond INR.
- Richer risk scoring (device fingerprinting, geo-velocity).
- A second LLM pass that critiques its own ranking rationale against the stored score breakdown before surfacing it, to catch narration drift.

## 39. Development Milestones

M1 (Phases 1–5): Foundations — auth, DB schema, policy CRUD, catalog CRUD/seed.
M2 (Phases 6–10): Agent pipeline — intent extraction, discovery, ranking with explainability.
M3 (Phases 11–15): Policy engine, approval system, state machine — all deterministic, all unit-tested, before any Razorpay code is written.
M4 (Phases 16–19): Razorpay integration — order creation, checkout, verification, webhooks, in Test Mode.
M5 (Phases 20–22): Audit trail, explainability endpoint, failure recovery/idempotency hardening.
M6 (Phases 23–25): Merchant analytics, observability, E2E test suite, demo polish.

## 40. Definition of Done (project-level)

- All 25 Cursor phases below individually meet their own DoD.
- The 11-step E2E happy path passes in CI against Razorpay Test Mode.
- All 8 negative-path E2E scenarios (Section 29) pass.
- No Razorpay Key Secret or webhook secret appears in any frontend bundle or client-visible network response (verified by a build-time grep check).
- Policy engine and state machine have 100% branch coverage.
- The 5-minute demo script (Section 33) runs end-to-end without manual DB intervention.

---

# Cursor Implementation Plan — 25 Sequential Phases

Each phase is designed to be handed to Cursor as a standalone, scoped prompt that builds strictly on artifacts from prior phases. "Files/modules" paths follow the backend/frontend layout in Sections 26–27.

---

**Phase 1 — Project scaffolding & environment**
Objective: Stand up the modular-monolith backend, React frontend, Postgres via Docker, and Prisma, with zero business logic yet.
Files: `/backend` (Express + TS skeleton), `/frontend` (Vite + React + TS + Tailwind + shadcn init), `docker-compose.yml`, `.env.example`, `/backend/prisma/schema.prisma` (empty models scaffold).
Requirements: health-check route (`GET /health`); frontend "Hello CommercePilot" page; Docker Compose brings up postgres + backend + frontend.
DB changes: none beyond an empty Prisma schema file with datasource config.
Dependencies: express, prisma, @prisma/client, react, vite, tailwindcss, zod, jsonwebtoken, bcrypt.
Acceptance criteria: `docker compose up` succeeds; `/health` returns 200; frontend renders.
Security: `.env` gitignored; `.env.example` has placeholder values only.
Edge cases: missing env vars fail fast with a clear startup error, not a silent crash.
Tests: a single smoke test hitting `/health`.
DoD: repo builds and runs clean on a fresh machine via `docker compose up`.

**Phase 2 — Users, auth, JWT**
Objective: Registration/login for `customer` and `merchant_admin` roles.
Files: `/backend/src/modules/auth/*`, `/backend/prisma/schema.prisma` (`users` model).
APIs: `POST /auth/register`, `POST /auth/login`.
DB: `users` table per Section 24.
Frontend: Login and Register pages, JWT stored in memory + httpOnly refresh cookie.
Requirements: bcrypt password hashing (cost ≥ 12), JWT access token (15 min) + refresh token (7 days, httpOnly cookie), role in JWT claims.
Acceptance criteria: register → login → protected route round-trip works; wrong password rejected with 401.
Security: passwords never logged; generic error message on login failure (no user-enumeration via distinct error text).
Edge cases: duplicate email registration → 409; malformed email → 400.
Tests: unit (password hashing/verification), integration (register/login flow).
DoD: a merchant_admin and a customer account can both be created and log in.

**Phase 3 — Financial policy CRUD**
Objective: Customers can create/view/update their single active financial policy.
Files: `/backend/src/modules/policy/*`, Prisma `financial_policies` model.
APIs: `POST /policies`, `GET /policies/me`.
DB: `financial_policies` per Section 24, `UNIQUE(user_id)`.
Frontend: Financial Policy Settings page (form for all policy fields from Section 10's FR-2).
Acceptance criteria: policy round-trips correctly; updating replaces (not appends) the active policy.
Security: only the owning customer can read/write their policy (ownership check middleware, reusable in later phases).
Edge cases: negative amounts rejected; `approval_threshold` > `max_autonomous_amount` allowed (documented as valid — approval threshold is the "ask a human above this" line, independent of the "unsupervised max" line) but validated as non-negative numbers.
Tests: unit (schema validation), integration (create/update roundtrip).
DoD: seeded demo policy from Section 32 can be created via this API.

**Phase 4 — Catalog schema & merchant CRUD**
Objective: Merchants and products exist and are manageable.
Files: `/backend/src/modules/catalog/*`, Prisma `merchants`, `products`, `product_attributes`.
APIs: `POST /products`, `PUT /products/:id`, `GET /products` (with category/maxPrice/tags filters).
Frontend: Product Management page (merchant_admin only).
Acceptance criteria: merchant_admin can create/update products; customer role gets 403 on write routes.
Security: role-based middleware from Phase 2 reused; input validation on price (≥ 0), stock (≥ 0).
Edge cases: filtering with no matches returns empty array, not error.
Tests: integration (CRUD + filter combinations).
DoD: `GET /products?category=Sports&maxPrice=5000` returns correctly filtered results.

**Phase 5 — Seed data script**
Objective: Deterministic, re-runnable seed script for demo data.
Files: `/backend/prisma/seed.ts`.
Requirements: 40–60 products across Electronics/Sports/Travel per Section 32, 3–5 merchants with varying trust_score, 1 demo customer with the exact policy from Section 32, the ₹4,499 running-shoe product and the ₹1,20,000 laptop product specifically included.
Acceptance criteria: `npx prisma db seed` is idempotent (safe to re-run, e.g. upsert by a stable seed key).
Edge cases: re-seeding doesn't create duplicate merchants/products.
Tests: a test asserting the two demo-critical products exist with exact prices after seeding.
DoD: fresh DB + seed produces a catalog sufficient to run the Section 33 demo script manually via API calls (before UI exists).

**Phase 6 — LLM provider abstraction**
Objective: A thin, swappable interface so no module calls a specific LLM SDK directly.
Files: `/backend/src/lib/llm-provider.ts` (interface: `generateStructured<T>(prompt, schema): Promise<T>`), concrete adapter for the chosen provider.
Requirements: structured-output mode (JSON schema constrained where the provider supports it), timeout + one retry on malformed output, then a typed error.
Acceptance criteria: a test prompt returns schema-valid JSON reliably; malformed responses throw a typed `LLMOutputError`, never crash the process.
Security: API key only from env; prompts never log full user PII beyond what's needed for debugging.
Edge cases: provider timeout → typed error, not hang.
Tests: unit test with a mocked provider returning both valid and invalid JSON.
DoD: any later module can call `llmProvider.generateStructured(...)` without knowing which vendor is behind it.

**Phase 7 — Intent Agent**
Objective: Convert free text into the structured intent shape from the brief.
Files: `/backend/src/modules/intent/*`.
APIs: internal function `extractIntent(rawText): StructuredIntent`, called from Phase 9's purchase-intent endpoint (not exposed standalone yet).
DB: `purchase_intents` model added (per Section 24), populated with `raw_text` + `structured_intent` at this phase's completion boundary.
Requirements: schema `{category, budget, currency, purpose, usage?, priority?, purchase_mode}`; zod validation on the LLM's structured output; reject/flag anything with a budget ≤ 0 or an unrecognized category (map to closest known category or return a clarification-needed flag — for hackathon scope, default to closest match plus a lower confidence score).
Security: this is the explicit prompt-injection boundary — raw user text is only ever passed to the LLM as *data to extract from*, never concatenated into a system-level instruction string that could grant it new capabilities.
Edge cases: empty text, text with no discernible category, text requesting multiple products at once (v1: take the first parseable intent, note the rest as unsupported).
Tests: unit tests with a mocked LLM provider across valid/ambiguous/malformed inputs.
DoD: `extractIntent("running shoes under 5000, I run 25km a week")` produces the exact example JSON from the brief.

**Phase 8 — Product Discovery Agent**
Objective: Turn a structured intent into a candidate product list.
Files: `/backend/src/modules/catalog/discovery.ts`.
Requirements: deterministic SQL query filtering by category + price ≤ budget + stock > 0; LLM only used optionally to expand tag synonyms (e.g. "running" → also search `athletic`, `trail`) before the SQL filter — never to rank or select.
Acceptance criteria: given the seeded catalog and the demo intent, returns the ₹4,499 shoe among candidates.
Edge cases: zero candidates → clear "no matching products" result, not an error.
Tests: unit (query building), integration (against seeded DB).
DoD: discovery returns a non-empty, budget-respecting candidate set for the demo intent.

**Phase 9 — Purchase intent endpoint + agent_runs**
Objective: Wire Intent Agent + Discovery Agent behind a real customer-facing endpoint with idempotency.
Files: `/backend/src/modules/orchestrator/purchase-intent.ts`, Prisma `agent_runs`.
APIs: `POST /purchase-intents` (accepts `Idempotency-Key` header), `GET /purchase-intents/:id`, `GET /purchase-intents`.
DB: `agent_runs` linked 1:1 to `purchase_intents`.
Requirements: on duplicate `Idempotency-Key` for the same user, return the existing intent instead of re-running extraction (Section 21).
Frontend: AI Shopping Chat page — submits text, polls/subscribes for intent status, shows extracted-intent JSON.
Acceptance criteria: two identical submissions with the same Idempotency-Key produce exactly one `purchase_intents` row.
Security: ownership check — a customer can only GET their own intents.
Edge cases: missing Idempotency-Key header → server generates one and returns it in the response for the client to reuse on retry.
Tests: integration test asserting idempotent double-submit behavior.
DoD: chat UI shows live intent extraction against the seeded catalog.

**Phase 10 — Ranking/Decision Agent + explainability data**
Objective: Deterministic scoring (Section 15) with LLM-generated rationale text layered on top, fully persisted.
Files: `/backend/src/modules/ranking/*`, Prisma `agent_decisions`.
Requirements: pure-function `scoreProduct(product, intent): {score, breakdown}` (no LLM call — testable in isolation); separate `explainTopPick(breakdown): string` that calls the LLM only to phrase already-computed numbers, never to invent them; persist all candidates' scores, not just the winner.
Frontend: Product Comparison page showing ranked candidates with factor breakdown.
Acceptance criteria: for the demo intent, the ₹4,499 shoe scores highest and the stored breakdown matches Section 15's formula exactly (verifiable in a unit test with known inputs).
Edge cases: out-of-stock or over-budget candidates always score 0 and are excluded from top-pick selection, per the hard-constraint rule.
Tests: unit (scoring formula, hard constraints), integration (full pipeline persists `agent_decisions` rows correctly).
DoD: `GET /agent/decisions/:intentId` returns a fully populated, numerically verifiable ranked list.

**Phase 11 — Policy Evaluation Service**
Objective: Implement Section 15's deterministic decision function as a standalone, LLM-free, network-free module.
Files: `/backend/src/modules/policy/evaluate.ts`, Prisma `policy_evaluations`.
Requirements: exact branch order from Section 15's pseudocode; pulls `todaySpend`/`todayAutonomousCount` from `orders` aggregated by day; persists a full `policy_snapshot` (a copy of the policy at evaluation time, for audit purposes even if the policy later changes).
Acceptance criteria: unit tests cover every branch — blocked category, not-in-allowed-list, daily limit exceeded, max txns/day reached, above approval threshold, above max autonomous, untrusted merchant, and the pure-ALLOW case.
Security: this module takes zero LLM input — its only inputs are DB rows and a plain-number proposal object.
Edge cases: `allowed_categories` empty array = "no allow-list restriction" (only `blocked_categories` applies) — this exact semantic is unit tested.
Tests: full branch-coverage unit suite (this is the single most safety-critical module in the system — coverage must be 100%).
DoD: feeding the ₹4,499 shoe through this function against the demo policy returns `ALLOW`/`WITHIN_POLICY`; feeding the ₹1,20,000 laptop returns `REQUIRE_APPROVAL`/`AMOUNT_ABOVE_APPROVAL_THRESHOLD`.

**Phase 12 — State machine module**
Objective: Centralize all legal/illegal transitions from Section 19 as a single reusable function.
Files: `/backend/src/lib/state-machine.ts`, Prisma migration adding `state` enum-like text column with CHECK constraint to `orders`/`purchase_intents` as applicable.
Requirements: `transition(current, event): next` throwing `IllegalTransitionError` for anything not in the Section 19 table; every module from here on calls this function rather than writing state strings directly.
Acceptance criteria: exhaustive unit test table mirroring Section 19 exactly, plus at least one illegal-transition test per state.
Tests: table-driven unit tests (one test case per row in Section 19's table, plus negatives).
DoD: no module in the codebase sets a `state`/`status` column directly outside this function (enforced by code review checklist, not just tests).

**Phase 13 — Orchestrator wiring: intent → ranking → policy**
Objective: Connect Phases 9–12 into the real pipeline up to (but not including) Razorpay/approvals.
Files: `/backend/src/modules/orchestrator/index.ts`.
Requirements: strict interface — the Orchestrator passes only `{user_id, product_id, amount, category, merchant_id}` into the Policy Evaluation Service, never the raw LLM output or raw text (Section 12's core invariant).
Acceptance criteria: full pipeline run for the demo intent ends in `PRODUCTS_RANKED` → `POLICY_ALLOWED` (shoe) or `→ APPROVAL_PENDING` (laptop), verified via `GET /purchase-intents/:id`.
Security: a code-level assertion/lint rule that no file under `/modules/intent` or `/modules/ranking` imports from `/modules/payments`.
Edge cases: policy DENY short-circuits before any product ranking cost is wasted on a blocked category (Section 15 ordering) — verify ranking is skipped entirely for a pre-known-blocked category in this phase's test.
Tests: integration test running the full non-payment pipeline end-to-end against the seeded DB for both demo products.
DoD: both demo scenarios (shoe → ALLOW, laptop → REQUIRE_APPROVAL) are reproducible via API calls alone.

**Phase 14 — Approval Service**
Objective: Implement Section 16's approval issuance, TTL, and single-consumption semantics.
Files: `/backend/src/modules/approvals/*`, Prisma `approvals`.
APIs: `GET /approvals/pending`, `POST /approvals/:id/decision`.
Requirements: atomic conditional update (`WHERE status='PENDING' AND expires_at > now()`) for both approve and reject; approval creation only triggered by the Orchestrator on a `REQUIRE_APPROVAL` policy result.
Frontend: Approval Screen (product, amount, merchant, reason/policy threshold, AI recommendation, risk info, Approve/Reject buttons).
Acceptance criteria: approving an already-consumed or expired approval returns `409 APPROVAL_ALREADY_CONSUMED`/`APPROVAL_EXPIRED`, never silently succeeds twice.
Security: ownership check — only the owning customer can act on their approval.
Edge cases: double-click Approve fires two requests; exactly one succeeds, the other gets `409`.
Tests: integration test simulating concurrent double-approve requests (race condition test).
DoD: the laptop demo scenario can be manually approved or rejected via the API/UI, with replay attempts provably rejected.

**Phase 15 — Deterministic pipeline E2E test gate (pre-Razorpay checkpoint)**
Objective: Lock in Phases 1–14 with a full non-payment E2E suite before any real money code is written — a deliberate milestone gate.
Files: `/tests/e2e/pre-payment.spec.ts` (Playwright, hitting the API layer or a minimal UI).
Requirements: covers register → policy → intent → ranking → ALLOW path, and register → policy → intent → ranking → REQUIRE_APPROVAL → approve, and → reject.
Acceptance criteria: all scenarios pass with zero network calls to Razorpay (payments module doesn't exist yet).
DoD: green E2E suite for everything except money movement — the "AI proposes, system decides" boundary is fully proven before payment risk is introduced.

**Phase 16 — Razorpay client + server-side order creation**
Objective: Real Orders API integration in Test Mode.
Files: `/backend/src/modules/payments/razorpay-client.ts`, `/backend/src/modules/payments/create-order.ts`, Prisma `orders`.
APIs: `POST /payments/create-order` (internal, called by Orchestrator once state is `POLICY_ALLOWED` or `APPROVED`).
Requirements: amount computed server-side (`Math.round(product.price * 100)`), `currency: "INR"`, `receipt: purchase_intent_id`, `notes: {source: "commercepilot_agent", purchase_intent_id, autonomous}`; Razorpay `key_id`/`key_secret` read from env, Basic Auth on the HTTP call; store returned `razorpay_order_id` on the `orders` row with state transition `order_created` (via Phase 12's state machine).
Acceptance criteria: a real Test Mode order is created and visible in the Razorpay dashboard for both the shoe (post-ALLOW) and laptop (post-approval) demo flows.
Security: grep-based build check confirms `RAZORPAY_KEY_SECRET` never appears in any file under `/frontend`.
Edge cases: duplicate call for the same `purchase_intent_id` (network retry) returns the existing order (Section 21) rather than creating a second Razorpay order — verified against `orders.purchase_intent_id UNIQUE`.
Tests: integration test against Razorpay's actual Test Mode API (using test credentials) confirming a real `order_xxx` id comes back; unit test for idempotent-create guard.
DoD: `orders` table row with a real `razorpay_order_id` exists and matches the dashboard for a full demo run.

**Phase 17 — Checkout integration (frontend)**
Objective: Wire Razorpay Standard Checkout into the Payment Screen.
Files: `/frontend/src/pages/PaymentScreen.tsx`, `/frontend/src/lib/razorpay-checkout.ts`.
Requirements: load `checkout.js` from Razorpay's CDN; open Checkout with `{key: VITE_RAZORPAY_KEY_ID, amount, currency, order_id, handler, prefill}`; on `handler` success, POST the three returned fields to `/payments/verify`; on dismiss/failure, call a status-check endpoint rather than assuming failure.
Acceptance criteria: a Test Mode payment can be completed end-to-end in the browser using Razorpay's published test card/UPI credentials.
Security: `key_id` only, sourced from a public env var; no secret ever present in browser devtools network tab beyond the public key.
Edge cases: user closes the Checkout modal without paying → frontend shows a "payment not completed, order still open" state rather than a false failure/success.
Tests: Playwright test driving the actual Checkout iframe with test-mode test-card values.
DoD: a completed Test Mode payment is visible both in CommercePilot's UI and Razorpay's dashboard.

**Phase 18 — Payment verification (server-side signature check)**
Objective: Implement Section 17/18's mandatory HMAC verification.
Files: `/backend/src/modules/payments/verify.ts`, `/backend/src/lib/hmac.ts`, Prisma `payments`.
APIs: `POST /payments/verify`.
Requirements: `HMAC-SHA256(order_id + "|" + payment_id, key_secret)` compared to the submitted `razorpay_signature` using a constant-time comparison; on match, `payments` row created with `signature_verified=true`, state → `PAYMENT_AUTHORIZED` (provisional, per Section 17 — not yet `COMPLETED`); on mismatch, state → `PAYMENT_VERIFICATION_FAILED`, flagged, no further Razorpay calls attempted for that order.
Security: constant-time string comparison (not `===`) to avoid timing side-channels; `key_secret` never logged even on failure.
Edge cases: replayed verify call for an already-verified payment is a safe no-op (idempotent per Section 21), not a duplicate `payments` row (`razorpay_payment_id UNIQUE`).
Tests: unit tests with known good/tampered/malformed signature inputs (can use fixed test vectors); integration test against a real Test Mode payment completed in Phase 17.
DoD: a genuine Test Mode payment verifies successfully; a manually tampered signature is provably rejected in a test.

**Phase 19 — Webhook receiver**
Objective: Implement Section 17/18/20/21's authoritative, idempotent webhook handling.
Files: `/backend/src/modules/webhooks/*`, Prisma `webhook_events`.
APIs: `POST /webhooks/razorpay` (raw body parsing required — must not run through a JSON-parsing middleware before signature validation).
Requirements: validate `X-Razorpay-Signature` = `HMAC-SHA256(raw_body, webhook_secret)`; on `payment.captured`/`order.paid`, finalize state to `PAYMENT_CAPTURED` → `COMPLETED` via the Phase 12 state machine; on `payment.failed`, → `PAYMENT_FAILED`; check `x-razorpay-event-id` against `webhook_events.event_id UNIQUE` before applying any state change, and always return 200 for a duplicate to prevent Razorpay's retry backoff from escalating.
Security: reject (400) any request with an invalid signature before any DB write; webhook secret sourced from env, distinct from `key_secret`.
Edge cases: webhook arrives before the client-side verify call completes (race) — state machine (Phase 12) makes this safe because `PAYMENT_PENDING → PAYMENT_CAPTURED` isn't a directly legal transition; instead the webhook path checks current state and, if still `PAYMENT_PENDING`, treats the webhook itself as sufficient to move through `PAYMENT_AUTHORIZED → PAYMENT_CAPTURED` in one recorded step, logged as such.
Tests: unit (signature validation with Razorpay's documented sample payload/signature format), integration (duplicate delivery test — same `event_id` twice, assert only one state transition and one audit entry).
DoD: a real Test Mode webhook (via ngrok during development) correctly finalizes an order to `COMPLETED`, and a manually replayed identical payload is a no-op.

**Phase 20 — Audit Service + timeline**
Objective: Every module from Phases 7–19 writes to `audit_logs`; expose the timeline.
Files: `/backend/src/modules/audit/*` (a single `recordAudit(entry)` function imported everywhere state changes), Prisma `audit_logs`.
APIs: `GET /agent/decisions/:intentId/timeline`.
Requirements: retrofit `recordAudit` calls into every prior phase's state-changing code path (intent extracted, products ranked, policy evaluated, approval created/decided, order created, payment verified, webhook processed) — this phase is explicitly a cross-cutting integration pass over existing modules, not new business logic.
Frontend: Agent Decision Timeline page rendering the Section 19-style example timeline with real timestamps.
Acceptance criteria: running the full demo flow produces a complete, chronologically ordered timeline with no gaps between major state transitions.
Security: `audit_logs` has no update/delete route exposed anywhere in the API surface.
Edge cases: a denied or rejected flow still produces a complete (shorter) timeline ending in its terminal state.
Tests: integration test asserting a full happy-path run produces all expected audit entries in order.
DoD: `GET /agent/decisions/:intentId/timeline` for a completed demo purchase matches Section 19's example structure.

**Phase 21 — Explainability endpoint**
Objective: Implement Section 10 FR-14's "why did you choose this?" from stored data only.
Files: `/backend/src/modules/ranking/explain.ts`.
APIs: `GET /agent/decisions/:intentId/explain`.
Requirements: pulls the winning `agent_decisions` row's `score_breakdown`, the matched `policy_evaluations` row, and templates a response combining both — LLM (if used at all here) only rephrases already-fetched numbers into prose, with the numbers themselves hard-inserted into the prompt as data, not regenerated.
Acceptance criteria: for the demo shoe purchase, the explanation cites the actual price (₹4,499), the actual budget (₹5,000), the actual rating, and the actual policy outcome — verifiable against the DB row, not just "looks plausible."
Edge cases: for a denied/approval-required intent, the explanation instead cites the policy `reason_code` and threshold values, not a product rationale.
Tests: integration test asserting every number in the explanation string matches a corresponding DB field exactly.
DoD: explanation text is provably non-hallucinated for at least one full test case (numeric cross-check in CI).

**Phase 22 — Failure recovery & idempotency hardening pass**
Objective: Implement Section 20's recovery table as concrete code, closing gaps left by earlier phases' happy-path focus.
Files: `/backend/src/modules/payments/recover.ts`, `/backend/src/lib/idempotency.ts`.
Requirements: a scheduled/triggered "reconciliation" check — for any order stuck in `PAYMENT_PENDING`/`PAYMENT_AUTHORIZED` beyond a timeout, perform a server-side Razorpay payment/order status fetch and reconcile state rather than waiting indefinitely for a webhook; cap reconciliation retries (max 3, exponential backoff), log every attempt to `audit_logs`.
Frontend: a safe "retry payment" action on the Payment Screen that reuses the existing `razorpay_order_id` rather than triggering a new order-creation call.
Acceptance criteria: simulate a dropped webhook in a test environment and confirm the reconciliation path still reaches `COMPLETED` via a direct status fetch.
Edge cases: reconciliation itself is idempotent — running it twice on an already-`COMPLETED` order is a no-op.
Tests: integration test simulating webhook non-delivery, asserting reconciliation succeeds within the retry cap; test asserting retries stop and surface a clear error after the cap is hit.
DoD: Section 20's full recovery table has a corresponding passing test for every row.

**Phase 23 — Merchant Analytics Service**
Objective: Implement Section 17 FR/Section 34's merchant-facing metrics.
Files: `/backend/src/modules/analytics/*`.
APIs: `GET /analytics/merchant`.
Requirements: aggregate queries over `orders`/`purchase_intents`/`policy_evaluations` for AI-assisted GMV, conversion rate, average order value, top products, and a feed of flagged/denied AI intents for merchant inspection.
Frontend: Merchant Dashboard, Analytics, Admin Order Management pages.
Acceptance criteria: after running the full demo script once, the merchant dashboard correctly reflects one completed order's GMV and one denied/approval-pending intent in the flagged feed.
Security: merchant_admin can only see orders/analytics for their own merchant_id (multi-tenant boundary check).
Edge cases: zero-order state renders a clean empty dashboard, not a crash on divide-by-zero in conversion-rate math.
Tests: integration test asserting metric values against a known seeded set of orders/intents.
DoD: dashboard numbers are independently verifiable against raw DB counts in a test.

**Phase 24 — Observability pass**
Objective: Implement Section 28 across the whole codebase.
Files: `/backend/src/lib/logger.ts`, correlation-ID middleware, retrofit into all modules.
Requirements: every request gets/propagates a correlation ID; every log line is structured JSON with module, level, correlation_id, and relevant entity IDs; no secrets in logs (a lint/test rule scanning log calls for `key_secret`/`webhook_secret`/`password` literals).
Acceptance criteria: a single demo run's logs can be filtered by one correlation ID to show the entire pipeline from intent submission to `COMPLETED`.
Tests: a test asserting no log line for a full pipeline run contains the raw `RAZORPAY_KEY_SECRET` value.
DoD: full-pipeline log trace is producible and secret-free.

**Phase 25 — E2E suite, seed reset, demo polish, and final DoD verification**
Objective: Final hardening pass before the hackathon demo.
Files: `/tests/e2e/*` (full Section 29 suite: happy path + 8 negative paths), `/backend/prisma/reset-demo.ts` (fast reset-to-seed script for repeatable live demos), UI polish pass across all 18 frontend pages per Section 26's visual language.
Requirements: full Playwright E2E suite green in CI; a one-command demo reset (`npm run demo:reset`) that restores the exact seeded state from Phase 5 so the live demo can be repeated without stale state; a final security grep-check confirming no secrets in any frontend bundle output.
Acceptance criteria: all items in Section 40's project-level Definition of Done pass.
Edge cases: running the demo reset mid-approval-pending state cleans up any orphaned `approvals`/`orders` rows correctly (cascading or explicit cleanup, no foreign-key violations).
Tests: this phase's own deliverable *is* the test suite; additionally, a meta-test asserting the demo reset script leaves the DB in a byte-identical state to a fresh seed.
DoD: project-level Definition of Done (Section 40) fully satisfied; the Section 33 demo script has been run at least once, end-to-end, with no manual DB edits, producing a real Test Mode Razorpay order visible in the Razorpay dashboard.

---

*End of PRD.*
