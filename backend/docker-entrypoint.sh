#!/bin/sh
set -e
echo "[commercepilot] applying Prisma migrations…"
npx prisma migrate deploy
echo "[commercepilot] starting API"
exec node dist/index.js
