# CommercePilot

The AI buyer with a financial conscience. Phase 1 scaffolding: Express API, Vite/React frontend, PostgreSQL.

## Prerequisites

- Docker with Compose v2 (enough to run the full stack)
- Node.js 20+ (only needed for local `npm` development outside Docker)

## Quick start

```bash
docker compose up --build
```

Then:

- Frontend: http://localhost:5173
- Health: `curl http://localhost:3000/health`

A machine with only Docker installed does not need to copy `.env`. Compose injects the required backend variables. For host-run development, copy `.env.example` to `.env` first.

## Local development (without Docker for Node)

```bash
cp .env.example .env
docker compose up postgres
cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

Backend tests:

```bash
cd backend && npm test
```

## TROUBLESHOOTING

**Port 5432 already in use.** `docker compose up` will fail immediately with a bind error such as `Bind for 0.0.0.0:5432 failed: port is already allocated` — it will not hang. Stop the other Postgres (or whatever is bound to 5432), or change the host mapping in `docker-compose.yml` (e.g. `"5433:5432"`) and point `DATABASE_URL` at the new host port.

**Backend exits on startup.** A missing or invalid required env var (`DATABASE_URL`, `FRONTEND_URL`) throws `EnvValidationError` and exits non-zero. Copy `.env.example` to `.env` and fill in the values, or run via Compose which supplies them.

**CORS errors from the browser.** The API allows only `FRONTEND_URL` (default `http://localhost:5173`). Requests from any other origin are rejected.
