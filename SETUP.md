# Setup

## Prerequisites

- Docker with Compose v2 (recommended for the full stack)
- Node.js 20+ (host runs for `npm`, seeds, and tests)
- Optional: Razorpay Test Mode keys from the [Razorpay Dashboard](https://dashboard.razorpay.com/) (Test Mode toggle)

## Environment variables

Copy `.env.example` → `.env` for host-run development. Compose injects the same keys into the backend container (see `docker-compose.yml`).

| Variable | Required to boot | Notes |
|---|---|---|
| `NODE_ENV` | no | `development` / `test` / `production` (Compose sets `production`) |
| `PORT` | no | Default `3000` |
| `DATABASE_URL` | yes | Postgres connection string |
| `FRONTEND_URL` | yes | CORS allow-list origin (default `http://localhost:5173`) |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | yes | Access + refresh signing secrets |
| `COOKIE_SECURE` | no | `false` for local HTTP; `true` behind HTTPS |
| `LLM_PROVIDER` | no | Optional; Compose defaults to `mock` (demo fixtures). Set `openai` + a real key for live LLM. |
| `LLM_PROVIDER_API_KEY` | no | Optional for boot; needed for live OpenAI calls (`replace-me` ok for stubbed demos) |
| `APPROVAL_TTL_MINUTES` | no | Default `15` |
| `RAZORPAY_KEY_ID` | no | Public Test Mode key id (`rzp_test_…`); placeholders use Orders stub |
| `RAZORPAY_KEY_SECRET` | no | **Backend only** — never expose to the frontend |
| `RAZORPAY_WEBHOOK_SECRET` | no | Distinct from Key Secret; required for live webhook verify |
| `PAYMENT_RECONCILE_*` | no | Phase 22 reconciliation timeouts / backoff |

### Obtaining Razorpay Test Mode credentials

1. Create / sign in at [dashboard.razorpay.com](https://dashboard.razorpay.com/).
2. Enable **Test Mode**.
3. **Settings → API Keys** — generate Test Key Id + Key Secret; put them in `.env`.
4. **Settings → Webhooks** — create a webhook with URL `https://<public-host>/webhooks/razorpay`, secret = `RAZORPAY_WEBHOOK_SECRET`, events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`.
5. Official India Test Mode card (docs): `4100 2800 0000 1007`, any future expiry, any CVV.

Placeholders (`rzp_test_replace_me` / `replace-me`) keep the API bootable: the backend uses an in-process Orders stub when credentials look like placeholders or when `NODE_ENV=test` injects a client double.

## Docker (full stack)

```bash
docker compose up --build
```

- Postgres: `localhost:5432`
- Backend: `http://localhost:3000` (runs `prisma migrate deploy` on start)
- Frontend: `http://localhost:5173` (nginx → static Vite build)

Then seed / reset demo fixtures from the host:

```bash
cd backend && npm install && npm run demo:reset
```

## Local development (Node on host)

```bash
cp .env.example .env
docker compose up postgres -d
cd backend && npm install && npx prisma migrate deploy && npm run demo:reset && npm run dev
cd frontend && npm install && npm run dev
```

## Migrations, seed, demo reset

| Command | Purpose |
|---|---|
| `cd backend && npx prisma migrate deploy` | Apply migrations (production / CI / Docker entrypoint) |
| `cd backend && npm run prisma:migrate` | Dev migrate (`prisma migrate dev`) |
| `cd backend && npm run prisma:seed` | Upsert catalog + demo users/policies |
| `cd backend && npm run demo:reset` | Truncate transactional tables + re-seed (repeatable demos) |
| `npm run demo:reset` | Same, from repo root |

`demo:reset` truncates transactional tables (`payments`, `webhook_events`, `approvals`, `agent_decisions`, `agent_runs`, `policy_evaluations`, `orders`, `audit_logs`, `notifications`, `purchase_intents`), **purges non-seed users/merchants/products** left by tests, then upserts the Phase 4/5 fixtures (4 merchants, 53 products, 5 users, Priya's policy).

## Razorpay webhooks and public HTTPS

Razorpay will not deliver webhooks to `http://localhost`. For local demos:

1. Expose the backend with a tunnel (e.g. ngrok / Cloudflare Tunnel) to a public **HTTPS** URL.
2. Point the Dashboard webhook at `https://<tunnel>/webhooks/razorpay`.
3. Use the same webhook secret as `RAZORPAY_WEBHOOK_SECRET`.

For the live hackathon demo, prefer a real deployed HTTPS backend. CommercePilot also has a server-side reconcile/status-fetch path (Phase 22) so UX does not hard-depend on webhook timing, but webhooks remain the authoritative finalize signal.

## Production builds

```bash
cd backend && npm run build
cd frontend && npm run build
```

## Troubleshooting

- **Port 5432 in use** — stop the other Postgres or remap Compose ports.
- **Backend exits on startup** — missing/invalid env (`EnvValidationError`); check `.env` / Compose env.
- **CORS errors** — browser origin must match `FRONTEND_URL`.
- **Empty catalog after Compose** — run `npm run demo:reset`.
