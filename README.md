# CommercePilot

**The AI buyer with a financial conscience.**

CommercePilot turns a natural-language shopping goal into a structured purchase proposal, ranks catalog products, and — only after a deterministic financial policy engine (and optional human approval) says yes — executes a real Razorpay Test Mode payment. The LLM proposes; it never authorizes money movement.

## Architecture (one sentence)

Intent Agent → Discovery → Ranking → **Policy Engine / Approvals / State Machine** → Payment Service → Checkout → Verify → Webhook → Audit / Explain.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the LLM-vs-deterministic boundary and state machine.

## Quick start

```bash
docker compose up --build
```

Then:

- Frontend: http://localhost:5173
- API health: `curl http://localhost:3000/health`

Compose applies Prisma migrations on backend boot. Seed / reset demo data from the host:

```bash
cd backend && npm install && npm run demo:reset
# or from repo root:
npm run demo:reset
```

Compose defaults `LLM_PROVIDER=mock` so the PRD demo phrases work without an OpenAI key. Set `LLM_PROVIDER=openai` and a real `LLM_PROVIDER_API_KEY` for live extraction.

Demo logins (password `password12`):

| Email | Role |
|---|---|
| `priya@commercepilot.demo` | customer |
| `arjun@apex.commercepilot.demo` | merchant_admin (Apex Sports) |

## Documentation

| Doc | Contents |
|---|---|
| [SETUP.md](./SETUP.md) | Local setup, env vars, migrations, Razorpay webhooks / HTTPS |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Agent pipeline, deterministic gates, payment states |
| [API.md](./API.md) | Full HTTP endpoint reference |
| [SECURITY.md](./SECURITY.md) | PRD §22–23 threats, mitigations, dependency notes |
| [TESTING.md](./TESTING.md) | How to run unit / integration / security / E2E suites |
| [DEMO_SCRIPT.md](./DEMO_SCRIPT.md) | ~5-minute live demo walkthrough |
| [HACKATHON_SUBMISSION.md](./HACKATHON_SUBMISSION.md) | Problem, differentiator, metrics, submission placeholders |

## Stack

- **Backend:** Express + TypeScript + Prisma + PostgreSQL
- **Frontend:** Vite + React + Tailwind
- **Payments:** Razorpay Orders + Standard Checkout + webhooks (Test Mode)
- **AI:** OpenAI structured-output adapter (tests use an in-process mock)

## License

Hackathon / demo project — see repository owner for distribution terms.
