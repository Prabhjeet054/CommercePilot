import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requireRole";
import { uuidParamSchema } from "../catalog/catalog.schema";
import { listTimelineForIntent } from "./audit.service";

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

/** Customer must own the intent; merchant_admin may read any intent timeline. */
async function requireTimelineAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const intentId = req.params.intentId;
    if (!intentId || !uuidParamSchema.safeParse(intentId).success) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id: intentId },
      select: { userId: true },
    });
    if (!intent) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    if (req.user.role === "merchant_admin" || intent.userId === req.user.id) {
      next();
      return;
    }

    res.status(404).json({ error: "NOT_FOUND" });
  } catch (err) {
    next(err);
  }
}

export async function getTimeline(req: Request, res: Response): Promise<void> {
  const intentId = req.params.intentId!;
  const events = await listTimelineForIntent(intentId);
  res.status(200).json({
    purchaseIntentId: intentId,
    events,
  });
}

export function createAuditRouter(): Router {
  const router = createRouter();
  router.get(
    "/agent/decisions/:intentId/timeline",
    requireAuth,
    requireRole(["customer", "merchant_admin"]),
    (req, res, next) => {
      void requireTimelineAccess(req, res, next);
    },
    wrap(getTimeline),
  );
  return router;
}
