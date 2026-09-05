import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { requireOwnership } from "../../middleware/requireOwnership";
import { requireRole } from "../../middleware/requireRole";
import { purchaseIntentWriteLimiter } from "../../middleware/rateLimit";
import { uuidParamSchema } from "../catalog/catalog.schema";
import * as orchestratorController from "./orchestrator.controller";

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

async function loadPurchaseIntentOwnership(req: Request): Promise<{ userId: string } | null> {
  const id = req.params.id;
  if (!id || !uuidParamSchema.safeParse(id).success) {
    return null;
  }
  const intent = await prisma.purchaseIntent.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!intent) {
    return null;
  }
  return { userId: intent.userId };
}

export function createOrchestratorRouter(): Router {
  const router = createRouter();

  router.post(
    "/purchase-intents",
    requireAuth,
    requireRole(["customer"]),
    purchaseIntentWriteLimiter(),
    wrap(orchestratorController.create),
  );
  router.get(
    "/purchase-intents",
    requireAuth,
    requireRole(["customer"]),
    wrap(orchestratorController.listMine),
  );
  router.get(
    "/purchase-intents/:id",
    requireAuth,
    requireRole(["customer"]),
    requireOwnership(loadPurchaseIntentOwnership),
    wrap(orchestratorController.getOne),
  );

  return router;
}
