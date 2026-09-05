# Demo Script (~5 minutes)

Reset first: `npm run demo:reset`.  
Log in as **Priya** — `priya@commercepilot.demo` / `password12`.

Official Razorpay India Test Mode card: `4100 2800 0000 1007`, any future expiry, any CVV.

---

### 0:00–0:30 — Policy Settings

1. Open http://localhost:5173/login → sign in as Priya.
2. Go to **Financial Policy** (`/policy`).
3. Show: max autonomous ₹5,000, daily limit ₹10,000, approval threshold ₹5,000, allowed categories Electronics / Sports / Travel, autonomous enabled.

### 0:30–1:30 — Autonomous shoe intent

1. Open **AI Shop** (`/shop`).
2. Enter the exact demo phrase (must match the fixture): *"I need running shoes under ₹5,000. I run around 25 km every week. Buy the best option automatically."* with mode **autonomous**.
3. Show structured intent + ranked candidates (Apex Stride Runner ₹4,499 should lead).

### 1:30–2:15 — Ranking explainability

1. Open compare / review for the intent (`/shop/:intentId/compare` or review).
2. Open **Explain** / timeline (`/shop/:intentId/timeline`) — scores and rationale use **stored** factor numbers (price fit, rating, specs), not free-form invention.

### 2:15–2:45 — Policy ALLOW

1. Show policy result: `ALLOW` / `WITHIN_POLICY` because ₹4,499 ≤ ₹5,000.
2. Intent status should be payable (`POLICY_ALLOWED`).

### 2:45–3:30 — Checkout → verify → COMPLETED

1. Continue to **Pay** (`/shop/:intentId/pay`).
2. Complete Razorpay Standard Checkout (Test Mode).
3. Show verification succeed (provisional authorized), then webhook/reconcile flip to **COMPLETED**.
4. Open the decision timeline with timestamps.

### 3:30–4:15 — Laptop requires approval

1. Back to `/shop`. Type: *"Buy me a laptop for ₹1,20,000."* (manual or autonomous — policy still gates).
2. Show `REQUIRE_APPROVAL`. On the seeded Priya policy (daily limit ₹10,000), the binding reason is typically **`DAILY_LIMIT_EXCEEDED`** (daily cap binds before the ₹5,000 approval threshold). Raising the daily limit above ₹1,20,000 surfaces `AMOUNT_ABOVE_APPROVAL_THRESHOLD` instead.
3. Confirm **no** Razorpay order yet.
4. Open **Approvals** (`/approvals`) — amount, reason, Approve/Reject.

### 4:15–5:00 — Reject + merchant analytics

1. Click **Reject** — denial path, zero money movement.
2. Log out; sign in as **Arjun** (`arjun@apex.commercepilot.demo` / `password12`).
3. Open **Merchant Dashboard** (`/merchant`) — AI-assisted GMV / conversion / pending or flagged activity.
4. Close on the differentiator: **AI proposes; deterministic system decides.**

---

### Operator tips

- Webhooks need a public HTTPS URL (see SETUP.md). Reconcile covers slow webhook delivery.
- Repeat the whole demo after `npm run demo:reset` without manual SQL.
