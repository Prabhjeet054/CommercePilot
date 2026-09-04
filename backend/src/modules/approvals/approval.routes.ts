import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { requireOwnership } from "../../middleware/requireOwnership";
import { requireRole } from "../../middleware/requireRole";
import * as approvalController from "./approval.controller";
import { approvalIdParamSchema } from "./approval.schema";

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

async function loadApprovalOwnership(req: Request): Promise<{ userId: string } | null> {
  const id = req.params.id;
  if (!id || !approvalIdParamSchema.safeParse(id).success) {
    return null;
  }
  const approval = await prisma.approval.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!approval) {
    return null;
  }
  return { userId: approval.userId };
}

export function createApprovalRouter(): Router {
  const router = createRouter();

  router.get(
    "/approvals/pending",
    requireAuth,
    requireRole(["customer"]),
    wrap(approvalController.listPending),
  );
  router.get(
    "/approvals/:id",
    requireAuth,
    requireRole(["customer"]),
    requireOwnership(loadApprovalOwnership),
    wrap(approvalController.getOne),
  );
  router.post(
    "/approvals/:id/decision",
    requireAuth,
    requireRole(["customer"]),
    requireOwnership(loadApprovalOwnership),
    wrap(approvalController.decide),
  );

  return router;
}
