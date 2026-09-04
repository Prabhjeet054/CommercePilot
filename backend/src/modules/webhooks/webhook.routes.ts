import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import {
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
  WebhookConfigError,
  WebhookSignatureError,
  handleRazorpayWebhook,
  verifyWebhookSignature,
} from "./webhook.service";

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

/**
 * POST /webhooks/razorpay — signature-authenticated (no JWT).
 * Must be mounted with `express.raw({ type: 'application/json' })` and
 * **before** the global `express.json()` parser so `req.body` stays a Buffer.
 */
export async function receiveRazorpayWebhook(req: Request, res: Response): Promise<void> {
  console.info(JSON.stringify({ level: "info", event: "webhook_received_validating" }));

  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    // Would happen if JSON middleware consumed the stream first — treat as misconfiguration.
    console.error(
      JSON.stringify({
        level: "error",
        event: "webhook_raw_body_missing",
        bodyType: typeof rawBody,
      }),
    );
    res.status(500).json({ error: "WEBHOOK_RAW_BODY_REQUIRED" });
    return;
  }

  const signature = req.header(RAZORPAY_SIGNATURE_HEADER) ?? undefined;
  let valid = false;
  try {
    valid = verifyWebhookSignature(rawBody, signature);
  } catch (err) {
    if (err instanceof WebhookConfigError) {
      console.error(`Webhook config error: ${err.message}`);
      res.status(503).json({ error: "WEBHOOK_NOT_CONFIGURED" });
      return;
    }
    throw err;
  }

  if (!valid) {
    console.error(JSON.stringify({ level: "error", event: "webhook_signature_invalid" }));
    res.status(400).json({ error: "INVALID_WEBHOOK_SIGNATURE" });
    return;
  }

  const eventId = req.header(RAZORPAY_EVENT_ID_HEADER)?.trim();
  if (!eventId) {
    // Signature matched but dedup id missing — acknowledge to avoid retry storms.
    console.warn(JSON.stringify({ level: "warn", event: "webhook_missing_event_id" }));
    res.status(200).json({ received: true, ignored: true });
    return;
  }

  try {
    const result = await handleRazorpayWebhook({
      rawBody,
      eventId,
      signatureValid: true,
    });
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      res.status(400).json({ error: "INVALID_WEBHOOK_SIGNATURE" });
      return;
    }
    throw err;
  }
}

export function createWebhookRouter(): Router {
  const router = createRouter();
  router.post("/razorpay", wrap(receiveRazorpayWebhook));
  return router;
}
