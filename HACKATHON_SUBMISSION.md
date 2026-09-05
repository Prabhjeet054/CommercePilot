# Hackathon Submission — CommercePilot

## Problem

Agentic commerce demos often give an LLM a `buy()` tool and rely on a system prompt for safety. Prompts are suggestions, not controls — prompt injection (including malicious catalog text) can push overspending, unauthorized categories, or skipped approvals.

## Solution / differentiator

CommercePilot makes the boundary real in code:

- The LLM may only **propose** a structured purchase.
- A deterministic **Policy Engine**, **Approval Service**, and **state machine** decide whether money moves.
- Razorpay Orders / Checkout / verify / webhooks run only on authorized, catalog-priced amounts.

A judge can watch a ₹1,20,000 laptop request stop **before** any Razorpay call — stronger than prompt-engineering claims.

## Architecture summary

See [ARCHITECTURE.md](./ARCHITECTURE.md). One-liner: Intent → Discovery → Ranking → Policy/Approval → Payment → Verify → Webhook → Audit/Explain.

## Business metrics (product)

**Customer:** time saved vs manual browse, checkout-step reduction, recommendation acceptance, % of spend kept within self-configured limits, approval responsiveness.

**Merchant:** AI-assisted GMV share, conversion for AI-driven traffic, AOV, autonomous repeat rate, pending/flagged intents visible on `/merchant`.

## Demo

- Script: [DEMO_SCRIPT.md](./DEMO_SCRIPT.md)
- Live URL: _«add deployed HTTPS URL»_
- Demo video: _«add link»_
- Repo: this repository

## How to run for judges

```bash
docker compose up --build
cd backend && npm install && npm run demo:reset
# Frontend http://localhost:5173 — Priya / password12
```

## Security highlight

Full threat → test map: `backend/tests/security/THREAT_CHECKLIST.md` and [SECURITY.md](./SECURITY.md).
