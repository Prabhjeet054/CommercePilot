import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requireRole";
import { uuidParamSchema } from "../catalog/catalog.schema";
import {
  ExplainNotFoundError,
  ExplainNotReadyError,
  explainPurchaseIntent,
} from "./explain-endpoint";

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

async function requireOwnerOnly(req: Request, res: Response, next: NextFunction): Promise<void> {
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
    if (!intent || intent.userId !== req.user.id) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

export async function getExplain(req: Request, res: Response): Promise<void> {
  const intentId = req.params.intentId!;
  const userId = req.user!.id;
  try {
    const result = await explainPurchaseIntent(intentId, userId);
    res.status(200).json({
      explanation: result.explanation,
      groundedFields: result.groundedFields,
      source: result.source,
    });
  } catch (err) {
    if (err instanceof ExplainNotFoundError) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    if (err instanceof ExplainNotReadyError) {
      res.status(409).json({
        error: "EXPLAIN_NOT_READY",
        message: "Explanation is not ready yet — ranking/policy has not finished.",
      });
      return;
    }
    throw err;
  }
}

export function createExplainRouter(): Router {
  const router = createRouter();
  router.get(
    "/agent/decisions/:intentId/explain",
    requireAuth,
    requireRole(["customer"]),
    (req, res, next) => {
      void requireOwnerOnly(req, res, next);
    },
    wrap(getExplain),
  );
  return router;
}
