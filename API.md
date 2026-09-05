# API Reference

All routes are served by the Express app (`backend/src/app.ts`). Unless noted, JSON request/response. Authenticated routes expect `Authorization: Bearer <accessToken>`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Liveness |
| POST | `/auth/register` | none | Register `customer` \| `merchant_admin` |
| POST | `/auth/login` | none | Login; sets httpOnly refresh cookie |
| POST | `/auth/refresh` | refresh cookie | Rotate access token |
| POST | `/auth/logout` | Bearer JWT (`requireAuth`) | Clear refresh cookie |
| GET | `/auth/me` | customer \| merchant_admin | Current user |
| GET | `/auth/admin-check` | merchant_admin | Role smoke check |
| GET | `/auth/ownership-check/:userId` | authenticated (owner) | Ownership middleware probe |
| GET | `/products` | authenticated | Catalog list (pagination) |
| GET | `/products/:id` | authenticated | Product detail |
| POST | `/products` | merchant_admin (own merchant) | Create product |
| PUT | `/products/:id` | merchant_admin (own merchant) | Update product |
| GET | `/merchants/:id` | authenticated | Merchant profile |
| GET | `/policies/me` | customer | Active financial policy |
| POST | `/policies` | customer | Upsert financial policy |
| POST | `/purchase-intents` | customer | Run agent pipeline (rate-limited) |
| GET | `/purchase-intents` | customer | List own intents |
| GET | `/purchase-intents/:id` | customer (owner) | Intent detail |
| GET | `/approvals/pending` | customer | Pending approvals |
| GET | `/approvals/:id` | customer (owner) | Approval detail |
| POST | `/approvals/:id/decision` | customer (owner) | `approve` \| `reject` (rate-limited, single-consume) |
| POST | `/payments/create-order` | customer (owner) | Create Razorpay order for payable intent |
| POST | `/payments/verify` | customer (owner) | Checkout HMAC verification |
| POST | `/payments/:orderId/retry` | customer (owner) | Reconcile / retry stuck payment |
| GET | `/analytics/merchant` | merchant_admin | Self-scoped merchant analytics |
| GET | `/agent/decisions/:intentId/timeline` | customer (owner) \| merchant_admin | Audit timeline |
| GET | `/agent/decisions/:intentId/explain` | customer (owner) | Grounded ranking explanation |
| POST | `/webhooks/razorpay` | Razorpay signature | Raw-body webhook receiver |

## Notes

- **Amounts:** monetary values in the DB are INR rupees (`Decimal(12,2)`). Razorpay amounts are paise, converted at the Payment Service boundary only. Client-supplied `amount` on create-order/verify is stripped by zod.
- **IDOR:** foreign resources return `404 NOT_FOUND`, not `403`.
- **Rate limits:** `/auth/login` (per IP); `/purchase-intents` and `/approvals/:id/decision` (per authenticated user).
- **Webhook:** signature over **raw** body with `RAZORPAY_WEBHOOK_SECRET`; dedupe via `x-razorpay-event-id` → `webhook_events.event_id` unique.
